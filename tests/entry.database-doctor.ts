import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {openBridgeResources} from '../src/service/resources.ts';
import {databaseDoctor} from '../src/service/database-doctor.ts';
import {deriveStoreKey} from '../src/service/store-key.ts';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {
    generateProfileSecret,
    saveProfileSecret,
    readProfileSecret,
} from '../src/setup/profile-secret.ts';

await test('read-only database doctor accepts correct keys, rejects wrong keys and preserves durable work', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'database-doctor-'));
    const config = parseServiceConfig(
        readFileSync('config.example.yaml', 'utf8')
            .replaceAll('/data', root)
            .replace('/run/secrets/matrix_crypto_store_key', join(root, 'matrix-key')),
    );
    try {
        saveProfileSecret(config.matrix.cryptoKeyFile, generateProfileSecret());
        const resources = openBridgeResources(config);
        try {
            resources.inbox.accept('preserved', {fixture: 'DO-NOT-LOG-MESSAGE'});
            const report = await databaseDoctor(config);
            assert.equal(report.status, 'pass');
            assert(!JSON.stringify(report).includes('DO-NOT-LOG'));
            assert.equal(resources.inbox.next()?.id, 'preserved');
        } finally {
            resources.close();
        }
        const files = ['journal', 'inbox', 'portals', 'outbox'].map((name) =>
            join(root, 'bridge', config.profileId, name + '.sqlite'),
        );
        const before = files.map((file) => readFileSync(file));
        assert.equal((await databaseDoctor(config, {requireCurrentSchema: true})).status, 'pass');
        files.forEach((file, i) => assert(readFileSync(file).equals(before[i]!)));
        const master = Buffer.from(readProfileSecret(config.matrix.cryptoKeyFile), 'base64url');
        const derived = deriveStoreKey(master, config, 'inbox');
        const db = new Database(join(root, 'bridge', config.profileId, 'inbox.sqlite'));
        try {
            db.pragma('cipher_log_level = NONE');
            db.pragma('cipher_compatibility = 4');
            db.pragma(`key = "x'${derived.toString('hex')}'"`);
            for (const version of [1, 999]) {
                db.pragma('user_version = ' + version);
                assert.equal((await databaseDoctor(config)).status, 'pass');
                assert.equal(
                    (await databaseDoctor(config, {requireCurrentSchema: true})).status,
                    'fail',
                );
                assert.equal(
                    db.pragma('user_version', {simple: true}),
                    version,
                    'Doctor must not migrate',
                );
            }
            db.pragma('user_version = 3');
        } finally {
            db.close();
            master.fill(0);
            derived.fill(0);
        }
        const wrongKey = join(root, 'wrong-key');
        saveProfileSecret(wrongKey, generateProfileSecret());
        assert.equal(
            (await databaseDoctor({...config, matrix: {...config.matrix, cryptoKeyFile: wrongKey}}))
                .status,
            'fail',
        );
        assert.equal((await databaseDoctor({...config, identity: 'OTHER123'})).status, 'fail');
        const reopened = openBridgeResources(config);
        try {
            assert.equal(reopened.inbox.next()?.id, 'preserved');
        } finally {
            reopened.close();
        }
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
