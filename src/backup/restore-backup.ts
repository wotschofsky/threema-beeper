import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {chmod, link, lstat, mkdir, open, readFile, realpath, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {list, extract} from '../../node_modules/tar/dist/esm/index.js';
import {decryptArchive} from './archive-crypto.ts';
import {backupCompatibility} from './compatibility.ts';

function safePath(path: string): boolean {
    return (
        path.length > 0 &&
        path.length <= 4096 &&
        !/[\\\u0000-\u001f:]/.test(path) &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
        (path === 'manifest.json' || ['profile', 'bridge', 'secrets'].includes(path.split('/')[0]!))
    );
}

/** Restore into a new private workspace/state; never overlay or start a live installation. */
export async function restoreBackup(
    source: string,
    destination: string,
    key: Buffer,
): Promise<void> {
    const parent = dirname(destination),
        info = await lstat(parent);
    if (
        !info.isDirectory() ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid()) ||
        (await realpath(parent)) !== parent
    )
        throw new Error('Restore requires private owned parent');
    await mkdir(destination, {mode: 0o700}); // Atomic reservation: never replace an existing path.
    try {
        const archive = join(destination, '.authenticated.tar');
        await decryptArchive(source, archive, key);
        const entries = new Map<string, {type: string; size: number}>();
        const folded = new Set<string>();
        let invalid = false,
            total = 0;
        await list({
            file: archive,
            strict: true,
            onReadEntry(entry) {
                const path =
                    entry.type === 'Directory' ? entry.path.replace(/\/$/, '') : entry.path;
                const fold = path.normalize('NFC').toLowerCase();
                total += entry.size;
                if (
                    !safePath(path) ||
                    !['File', 'Directory'].includes(entry.type) ||
                    entries.has(path) ||
                    folded.has(fold) ||
                    !Number.isSafeInteger(entry.size) ||
                    entry.size < 0 ||
                    entries.size >= 1_000_000 ||
                    total > 100 * 1024 ** 3 ||
                    (path === 'manifest.json' && entry.size > 16 * 1024 ** 2)
                )
                    invalid = true;
                entries.set(path, {type: entry.type, size: entry.size});
                folded.add(fold);
            },
        });
        assert(
            !invalid && entries.get('manifest.json')?.type === 'File',
            'Invalid backup archive inventory',
        );
        for (const [path] of entries) {
            for (let parent = dirname(path); parent !== '.'; parent = dirname(parent))
                assert(
                    entries.get(parent)?.type === 'Directory',
                    'Missing or invalid archive parent',
                );
        }
        const state = join(destination, 'state');
        await mkdir(state, {mode: 0o700});
        await extract({
            file: archive,
            cwd: state,
            strict: true,
            preservePaths: false,
            noChmod: true,
            noMtime: true,
        });
        const manifest = JSON.parse(await readFile(join(state, 'manifest.json'), 'utf8'));
        assert(
            manifest.schemaVersion === 2 &&
                /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(manifest.profileId) &&
                /^[A-Z0-9*][A-Z0-9]{7}$/.test(manifest.identity) &&
                Array.isArray(manifest.files),
        );
        assert.deepEqual(
            manifest.compatibility,
            await backupCompatibility(),
            'Backup upstream sources differ from installed sources',
        );
        const declared = new Set<string>();
        for (const file of manifest.files) {
            assert(
                typeof file.path === 'string' &&
                    safePath(file.path) &&
                    file.path !== 'manifest.json' &&
                    !declared.has(file.path),
            );
            assert(
                entries.get(file.path)?.type === 'File' &&
                    entries.get(file.path)?.size === file.bytes &&
                    /^[0-9a-f]{64}$/.test(file.sha256),
            );
            assert(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777);
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(join(state, file.path))) hash.update(chunk);
            assert.equal(hash.digest('hex'), file.sha256, 'Restored file checksum mismatch');
            await chmod(
                join(state, file.path),
                file.path.startsWith('secrets/') && file.mode === 0o400 ? 0o400 : 0o600,
            );
            declared.add(file.path);
        }
        assert.equal(
            declared.size + 1,
            [...entries.values()].filter((entry) => entry.type === 'File').length,
        );
        for (const required of [
            'secrets/threema-profile',
            'secrets/matrix-key',
            'secrets/registration',
        ])
            assert(declared.has(required));
        for (const root of ['profile', 'bridge', 'secrets'])
            assert(entries.get(root)?.type === 'Directory');
        for (const [path, entry] of entries)
            if (entry.type === 'Directory') await chmod(join(state, path), 0o700);
        await chmod(join(state, 'manifest.json'), 0o600);
        // Persist file contents and final modes before any completion marker is visible.
        const synchronize = async (path: string) => {
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        };
        for (const [path, entry] of entries)
            if (entry.type === 'File') await synchronize(join(state, path));
        const directories = [...entries]
            .filter(([, entry]) => entry.type === 'Directory')
            .map(([path]) => path)
            .sort((a, b) => b.split('/').length - a.split('/').length);
        for (const path of directories) await synchronize(join(state, path));
        await synchronize(state);
        await rm(archive);
        await synchronize(destination);
        const manifestBytes = await readFile(join(state, 'manifest.json'));
        const markerPath = join(destination, '.restore-complete.tmp');
        const marker = await open(markerPath, 'wx', 0o600);
        try {
            await marker.writeFile(
                JSON.stringify(
                    {
                        schemaVersion: 1,
                        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
                        verifiedFiles: declared.size,
                        completedAt: new Date().toISOString(),
                    },
                    null,
                    2,
                ) + '\n',
            );
            await marker.sync();
        } finally {
            await marker.close();
        }
        await link(markerPath, join(destination, 'RESTORE-COMPLETE.json'));
        await rm(markerPath);
        await synchronize(destination);
        await synchronize(parent);
    } catch {
        await rm(destination, {recursive: true, force: true});
        throw new Error('Backup restore validation failed');
    }
}
