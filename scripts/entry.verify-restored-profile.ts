// Run only against a stopped, adopted restore. All native opens use temporary copies.
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash, randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readServiceConfig} from '../src/service/config.ts';
import {readProfileSecret} from '../src/setup/profile-secret.ts';
const installation = process.argv[2];
assert(installation && process.argv.length === 3);
const config = await readServiceConfig(join(installation, 'bridge.yaml'));
const source = join(installation, 'data/profiles', config.profileId);
const password = readProfileSecret(join(installation, 'secrets/threema-profile'));
const require = createRequire(import.meta.url);
const {
    verifyRestoredProfile,
} = require('../.local/sources/threema-desktop/apps/desktop/build/restore-probe/restore-probe.cjs');
const temp = await mkdtemp(join(tmpdir(), 'native-restore-'));
const files = [
    'data/keystorage.bin',
    'data/keystorage.pb3',
    'data/threema.sqlite',
    'data/threema.sqlite-wal',
    'data/threema.sqlite-shm',
];
const before = new Map<string, string>();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
    for (const file of files) {
        let info;
        try {
            info = await stat(join(source, file));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw e;
        }
        assert(info.isFile());
        before.set(file, hash(await readFile(join(source, file))));
        await mkdir(join(temp, 'data'), {recursive: true, mode: 0o700});
        await cp(join(source, file), join(temp, file), {force: false, errorOnExist: true});
    }
    assert(
        before.has('data/threema.sqlite') &&
            (before.has('data/keystorage.bin') || before.has('data/keystorage.pb3')),
    );
    await assert.rejects(
        verifyRestoredProfile(temp, randomBytes(32).toString('base64url'), config.identity),
        (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'type' in error &&
            error.type === 'undecryptable',
    );
    const result = await verifyRestoredProfile(temp, password, config.identity);
    assert(result.identityMatches && result.databaseIntegrity);
    const again = await verifyRestoredProfile(temp, password, config.identity);
    assert.deepEqual(again, result);
    for (const [file, digest] of before)
        assert.equal(hash(await readFile(join(source, file))), digest);
    console.log(
        JSON.stringify({
            architecture: process.arch,
            wrongPasswordRejected: true,
            identityMatches: true,
            databaseIntegrity: true,
            reopenPassed: true,
            sourceUnchanged: true,
            backendStarted: false,
        }),
    );
} finally {
    await rm(temp, {recursive: true, force: true});
}
