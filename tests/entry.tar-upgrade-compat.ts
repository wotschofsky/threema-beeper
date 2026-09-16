import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {captureSnapshot} from '../src/backup/snapshot.ts';
import {encryptArchive} from '../src/backup/archive-crypto.ts';
import {restoreBackup} from '../src/backup/restore-backup.ts';
import {parseServiceConfig} from '../src/service/config.ts';
import {list} from '../node_modules/tar/dist/esm/index.js';

// Explicit old installation, retained outside the runtime package, supplies the
// previous writer. Only synthetic data is archived; no live installation is read.
assert.equal(process.argv.length, 3, 'Provide the retained tar 7.5.16 package directory');
const oldPackage = resolve(process.argv[2]!);
assert.equal(JSON.parse(await readFile(join(oldPackage, 'package.json'), 'utf8')).version, '7.5.16');
assert.equal(JSON.parse(await readFile('node_modules/tar/package.json', 'utf8')).version, '7.5.21');
const legacy = await import(pathToFileURL(join(oldPackage, 'dist/esm/index.js')).href);

await test('7.5.21 restores an encrypted backup written by 7.5.16', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'tar-compat-'));
    try {
        const config = parseServiceConfig(await readFile('config.example.yaml', 'utf8'));
        config.dataDirectory = root;
        config.profileDirectory = join(root, 'profile');
        config.passwordFile = join(root, 'threema-key');
        config.matrix.cryptoKeyFile = join(root, 'matrix-key');
        config.matrix.registrationFile = join(root, 'registration');
        const bridge = join(root, 'bridge', config.profileId);
        await mkdir(config.profileDirectory, {mode: 0o700});
        await mkdir(bridge, {recursive: true, mode: 0o700});
        for (const file of [config.passwordFile, config.matrix.cryptoKeyFile, config.matrix.registrationFile]) {
            await writeFile(file, 'synthetic compatibility fixture', {mode: 0o400});
        }
        const content = Buffer.alloc(1024 * 1024, 37);
        await writeFile(join(config.profileDirectory, 'profile.bin'), content, {mode: 0o600});
        await writeFile(join(bridge, 'journal.bin'), 'synthetic journal', {mode: 0o600});
        const snapshot = join(root, 'snapshot');
        await captureSnapshot(config, snapshot);
        const archive = legacy.create({cwd: snapshot, portable: true, noMtime: true, strict: true},
            ['manifest.json', 'profile', 'bridge', 'secrets']);
        const backup = join(root, 'legacy.enc');
        const key = Buffer.alloc(32, 41);
        await encryptArchive(Readable.from(archive), backup, key);
        const restored = join(root, 'restored');
        await restoreBackup(backup, restored, key);
        assert.deepEqual(await readFile(join(restored, 'state/profile/profile.bin')), content);
        assert.equal(await readFile(join(restored, 'state/bridge/journal.bin'), 'utf8'), 'synthetic journal');
        assert.equal(await readFile(join(restored, 'state/secrets/threema-profile'), 'utf8'), 'synthetic compatibility fixture');
        assert.equal(JSON.parse(await readFile(join(restored, 'RESTORE-COMPLETE.json'), 'utf8')).schemaVersion, 1);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});

await test('new parser rejects a bounded archive exceeding its default decompression ratio', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'tar-ratio-'));
    try {
        // Four MiB of zeros is enough to exceed the default ratio, without an
        // unbounded producer or extraction to disk.
        await writeFile(join(root, 'zeros'), Buffer.alloc(4 * 1024 * 1024));
        const file = join(root, 'compressed.tar.gz');
        await legacy.create({cwd: root, file, gzip: true, portable: true, noMtime: true}, ['zeros']);
        await assert.rejects(list({file, strict: true}), /max decompression ratio exceeded/);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});
