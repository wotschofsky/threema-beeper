import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, chmod, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {openBridgeResources} from '../src/service/resources.ts';
import {generateProfileSecret, saveProfileSecret} from '../src/setup/profile-secret.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
const example = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'threema-resources-'));
    const config = parseServiceConfig(
        example
            .replaceAll('/data', directory)
            .replace('/run/secrets/matrix_crypto_store_key', join(directory, 'master.key')),
    );
    saveProfileSecret(config.matrix.cryptoKeyFile, generateProfileSecret());
    return {directory, config};
}
await test('service stores persist with separate keys and exclusive ownership, and close wipes the Matrix key', async () => {
    const {directory, config} = await fixture();
    try {
        let resources = openBridgeResources(config);
        assert.equal(resources.checkHealth(), true);
        resources.inbox.accept('persistent-transaction', {fixture: 'private'});
        const key = resources.matrixKey;
        const expected = Buffer.from(key);
        assert.throws(() => openBridgeResources(config), /already open/);
        assert.throws(
            () =>
                openBridgeResources({
                    ...config,
                    profileId: 'secondary',
                    profileDirectory: join(directory, 'profiles', 'secondary'),
                }),
            /already open/,
            'Two profiles cannot share an active media cleanup directory',
        );
        assert.throws(
            () => new TransactionInbox(join(directory, 'bridge', 'primary', 'inbox.sqlite'), key),
        );
        resources.close();
        assert.equal(resources.checkHealth(), false);
        resources.close();
        assert.ok(key.every((byte) => byte === 0));
        resources = openBridgeResources(config);
        assert.equal(resources.inbox.next()!.id, 'persistent-transaction');
        assert.deepEqual(resources.matrixKey, expected);
        resources.close();
        expected.fill(0);
        assert.ok(
            !(await readFile(join(directory, 'bridge', 'primary', 'inbox.sqlite'))).includes(
                Buffer.from('private'),
            ),
        );
        const anotherKey = join(directory, 'wrong.key');
        saveProfileSecret(anotherKey, generateProfileSecret());
        assert.throws(() =>
            openBridgeResources({...config, matrix: {...config.matrix, cryptoKeyFile: anotherKey}}),
        );
        resources = openBridgeResources(config);
        assert.equal(
            resources.inbox.next()!.id,
            'persistent-transaction',
            'Failed initialization must release ownership and preserve encrypted data',
        );
        resources.close();
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
await test('resource startup rejects public data, escaping media paths and symlink database files', async () => {
    const {directory, config} = await fixture();
    try {
        await chmod(directory, 0o755);
        assert.throws(() => openBridgeResources(config), /private owned/);
        await chmod(directory, 0o700);
        assert.throws(
            () =>
                openBridgeResources({
                    ...config,
                    media: {...config.media, temporaryDirectory: join(directory, 'profiles')},
                }),
            /beneath the runtime/,
        );
        const resources = openBridgeResources(config);
        resources.close();
        const filename = join(directory, 'bridge', 'primary', 'inbox.sqlite');
        await rm(filename);
        const outside = join(directory, 'untouched');
        await writeFile(outside, 'must not change', {mode: 0o600});
        await symlink(outside, filename);
        assert.throws(() => openBridgeResources(config), /Unsafe bridge database/);
        assert.equal(await readFile(outside, 'utf8'), 'must not change');
        await rm(filename);
        const recovered = openBridgeResources(config);
        recovered.close();
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
