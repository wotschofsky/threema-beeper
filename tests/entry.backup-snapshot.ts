import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {createBackup} from '../src/backup/create-backup.ts';
import {decryptArchive, encryptArchive} from '../src/backup/archive-crypto.ts';
import {Readable} from 'node:stream';
import {restoreBackup} from '../src/backup/restore-backup.ts';
import {verifyRestoreWorkspace} from '../src/backup/verify-workspace.ts';
import {list, create} from '../node_modules/tar/dist/esm/index.js';
import {existsSync} from 'node:fs';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {captureSnapshot} from '../src/backup/snapshot.ts';
import {parseServiceConfig} from '../src/service/config.ts';
import {ProfileLock} from '../src/threema/profile-lock.ts';

await test('snapshot holds live locks, captures one private set, hashes large files and cleans failed destinations', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'backup-snapshot-'));
    const config = parseServiceConfig(await readFile('config.example.yaml', 'utf8'));
    config.dataDirectory = root;
    config.profileDirectory = join(root, 'profile');
    config.passwordFile = join(root, 'threema-key');
    config.matrix.cryptoKeyFile = join(root, 'matrix-key');
    config.matrix.registrationFile = join(root, 'registration');
    const bridge = join(root, 'bridge', config.profileId),
        destination = join(root, 'snapshot');
    try {
        await mkdir(config.profileDirectory, {mode: 0o700});
        await mkdir(bridge, {recursive: true, mode: 0o700});
        for (const path of [
            config.passwordFile,
            config.matrix.cryptoKeyFile,
            config.matrix.registrationFile,
        ])
            await writeFile(path, 'private fixture', {mode: 0o400});
        const content = Buffer.alloc(2 * 1024 * 1024, 37);
        await writeFile(join(config.profileDirectory, 'data'), content, {mode: 0o600});
        await writeFile(join(bridge, 'journal.sqlite'), 'synthetic cipher data', {mode: 0o600});
        for (const path of [config.profileDirectory, bridge]) {
            const lock = new ProfileLock(path);
            try {
                await assert.rejects(captureSnapshot(config, destination));
                assert(!existsSync(destination));
            } finally {
                lock.close();
            }
        }
        await captureSnapshot(config, destination);
        const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
        assert.equal(manifest.files.length, 5);
        assert.equal(
            manifest.files.find((file: {path: string}) => file.path === 'profile/data').sha256,
            createHash('sha256').update(content).digest('hex'),
        );
        assert((await readFile(join(destination, 'profile/data'))).equals(content));
        await assert.rejects(captureSnapshot(config, destination));
        assert(existsSync(join(destination, 'manifest.json')));
        await rm(destination, {recursive: true});
        const key = randomBytes(32);
        try {
            const backup = join(root, 'backup.enc');
            await createBackup(config, backup, key);
            assert(!(await readFile(backup)).includes(Buffer.from('private fixture')));
            await decryptArchive(backup, join(root, 'archive.tar'), key);
            const entries: string[] = [];
            await list({
                file: join(root, 'archive.tar'),
                onReadEntry: (entry) => {
                    entries.push(entry.path);
                },
            });
            assert(entries.includes('manifest.json'));
            assert(entries.includes('profile/data'));
            assert(entries.includes('bridge/journal.sqlite'));
            assert(entries.includes('secrets/matrix-key'));
            assert(!entries.some((path) => path.includes('bridge-profile-lock')));
            const restored = join(root, 'restore');
            await restoreBackup(backup, restored, key);
            await verifyRestoreWorkspace(restored);
            await verifyRestoreWorkspace(restored, config);
            for (const changed of [
                {...config, owner: '@different:example.invalid'},
                {...config, identity: 'OTHER123'},
                {...config, matrix: {...config.matrix, namespace: 'other'}},
                {...config, matrix: {...config.matrix, homeserver: 'https://other.invalid'}},
            ])
                await assert.rejects(verifyRestoreWorkspace(restored, changed), {
                    message: 'Restored workspace verification failed',
                });
            const completion = JSON.parse(
                await readFile(join(restored, 'RESTORE-COMPLETE.json'), 'utf8'),
            );
            const restoredManifest = await readFile(join(restored, 'state/manifest.json'));
            assert.equal(
                completion.manifestSha256,
                createHash('sha256').update(restoredManifest).digest('hex'),
            );
            assert.equal(completion.verifiedFiles, 5);
            assert(!existsSync(join(restored, '.authenticated.tar')));

            assert((await readFile(join(restored, 'state/profile/data'))).equals(content));
            await assert.rejects(restoreBackup(backup, restored, key));
            await assert.rejects(
                restoreBackup(backup, join(root, 'wrong-restore'), randomBytes(32)),
            );
            assert(!existsSync(join(root, 'wrong-restore')));
            const state = join(restored, 'state');
            const pack = async (name: string) => {
                const archive = create({cwd: state, portable: true}, [
                    'manifest.json',
                    'profile',
                    'bridge',
                    'secrets',
                ]);
                await encryptArchive(
                    Readable.from(archive as unknown as AsyncIterable<Buffer>),
                    join(root, name),
                    key,
                );
            };
            await symlink(config.passwordFile, join(state, 'profile', 'escape'));
            await pack('linked.enc');
            await assert.rejects(
                restoreBackup(join(root, 'linked.enc'), join(root, 'linked-restore'), key),
            );
            assert(!existsSync(join(root, 'linked-restore')));
            await rm(join(state, 'profile', 'escape'));
            const manifestPath = join(state, 'manifest.json');
            const originalManifest = await readFile(manifestPath, 'utf8');
            const incompatible = JSON.parse(originalManifest);
            incompatible.compatibility.repositories[0].commit = '0'.repeat(40);
            await writeFile(manifestPath, JSON.stringify(incompatible));
            await pack('incompatible.enc');
            await assert.rejects(
                restoreBackup(
                    join(root, 'incompatible.enc'),
                    join(root, 'incompatible-restore'),
                    key,
                ),
            );
            assert(!existsSync(join(root, 'incompatible-restore')));
            await writeFile(manifestPath, originalManifest);
            await writeFile(join(state, 'profile', 'data'), 'changed');
            await assert.rejects(verifyRestoreWorkspace(restored));
            await pack('tampered.enc');
            await assert.rejects(
                restoreBackup(join(root, 'tampered.enc'), join(root, 'tampered-restore'), key),
            );
            assert(!existsSync(join(root, 'tampered-restore')));
        } finally {
            key.fill(0);
        }
        await symlink(config.passwordFile, join(bridge, 'unsafe'));
        await assert.rejects(captureSnapshot(config, destination));
        assert(!existsSync(destination));
        const lock = new ProfileLock(config.profileDirectory);
        lock.close();
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});
