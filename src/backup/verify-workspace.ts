import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {backupCompatibility} from './compatibility.ts';
import {backupProfileBinding} from './profile-binding.ts';
import type {ServiceConfig} from '../service/config.ts';

/** Read-only verification. Completion records are consistency markers, not signatures. */
export async function verifyRestoreWorkspace(
    workspace: string,
    config?: ServiceConfig,
): Promise<void> {
    async function privatePath(path: string, directory: boolean) {
        const stat = await lstat(path);
        assert((directory ? stat.isDirectory() : stat.isFile()) && !stat.isSymbolicLink());
        assert(!(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid()));
        assert((await realpath(path)) === path);
        if (!directory) assert(stat.nlink === 1);
        return stat;
    }
    async function readJson(path: string, maximum: number) {
        const stat = await privatePath(path, false);
        assert(stat.size <= maximum);
        const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const data = Buffer.alloc(maximum + 1);
            let length = 0;
            while (length < data.length) {
                const result = await handle.read(data, length, data.length - length, null);
                if (!result.bytesRead) break;
                length += result.bytesRead;
            }
            assert(length <= maximum);
            const bytes = data.subarray(0, length);
            return {
                value: JSON.parse(bytes.toString('utf8')),
                hash: createHash('sha256').update(bytes).digest('hex'),
            };
        } finally {
            await handle.close();
        }
    }
    try {
        await privatePath(workspace, true);
        assert.deepEqual((await readdir(workspace)).sort(), ['RESTORE-COMPLETE.json', 'state']);
        const {value: marker} = await readJson(join(workspace, 'RESTORE-COMPLETE.json'), 4096);
        const state = join(workspace, 'state');
        await privatePath(state, true);
        const {value: manifest, hash} = await readJson(
            join(state, 'manifest.json'),
            16 * 1024 ** 2,
        );
        assert(
            marker.schemaVersion === 1 &&
                marker.manifestSha256 === hash &&
                manifest.schemaVersion === 2,
        );
        assert(Array.isArray(manifest.files) && marker.verifiedFiles === manifest.files.length);
        assert.deepEqual(manifest.compatibility, await backupCompatibility());
        if (config) {
            assert.equal(manifest.profileId, config.profileId);
            assert.equal(manifest.identity, config.identity);
            assert.deepEqual(manifest.binding, backupProfileBinding(config));
        }
        const expected = new Map<string, {bytes: number; sha256: string}>();
        for (const file of manifest.files) {
            assert(typeof file.path === 'string' && !expected.has(file.path));
            assert(
                Number.isSafeInteger(file.bytes) &&
                    file.bytes >= 0 &&
                    /^[0-9a-f]{64}$/.test(file.sha256),
            );
            expected.set(file.path, file);
        }
        let count = 0;
        async function walk(path: string): Promise<void> {
            const full = join(state, path);
            const stat = await lstat(full);
            if (stat.isDirectory()) {
                await privatePath(full, true);
                for (const child of await readdir(full))
                    await walk(path ? path + '/' + child : child);
                return;
            }
            await privatePath(full, false);
            if (path === 'manifest.json') return;
            const record = expected.get(path);
            assert(record && record.bytes === stat.size);
            const file = await open(
                full,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
                const hash = createHash('sha256');
                for await (const chunk of file.createReadStream({autoClose: false}))
                    hash.update(chunk);
                assert.equal(hash.digest('hex'), record.sha256);
            } finally {
                await file.close();
            }
            count++;
        }
        await walk('');
        assert.equal(count, expected.size);
    } catch {
        throw new Error('Restored workspace verification failed');
    }
}
