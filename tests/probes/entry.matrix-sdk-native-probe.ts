import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
    MatrixClient,
    MemoryStorageProvider,
    LogService,
    LogLevel,
    EncryptedRoomEvent,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProtectedCryptoStorage} from '../../src/matrix/protected-storage.ts';

assert.equal(process.versions.node.split('.')[0], '24');
LogService.setLevel(LogLevel.ERROR);

await test('patched SDK prepares native crypto with protected metadata and survives restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-sdk-native-'));
    const key = randomBytes(32);
    const userId = '@synthetic:example.invalid';
    let storage: ProtectedCryptoStorage | undefined;
    let client: MatrixClient | undefined;
    const requests: string[] = [];
    let sentContent: Record<string, unknown> | undefined;
    const roomId = '!synthetic:example.invalid';
    const body = 'synthetic message through SDK encryption';
    // Intercept the SDK transport only. Rust crypto and SDK preparation are real; no network is used.
    function createClient(store: ProtectedCryptoStorage): MatrixClient {
        const result = new MatrixClient(
            'https://example.invalid',
            'synthetic',
            new MemoryStorageProvider(),
            store,
        );
        result.doRequest = async (
            _method: string,
            path: string,
            _query?: unknown,
            payload?: unknown,
        ): Promise<any> => {
            requests.push(path);
            if (path.endsWith('/account/whoami')) return {user_id: userId, device_id: 'SYNTHETIC'};
            if (path.endsWith('/keys/upload'))
                return {one_time_key_counts: {signed_curve25519: 50}};
            if (path.endsWith('/keys/query')) return {device_keys: {}, failures: {}};
            if (path.endsWith('/members'))
                return {
                    chunk: [
                        {
                            type: 'm.room.member',
                            state_key: userId,
                            sender: userId,
                            content: {membership: 'join'},
                        },
                    ],
                };
            if (path.includes('/send/')) {
                assert.ok(path.includes('/send/m.room.encrypted/'), 'Refuse plaintext room sends');
                sentContent = payload as Record<string, unknown>;
                return {event_id: '$synthetic'};
            }
            throw new Error(`Unexpected mock request: ${path}`);
        };
        return result;
    }
    try {
        storage = new ProtectedCryptoStorage(directory, key);
        client = createClient(storage);
        await client.crypto.prepare();
        assert.ok(client.crypto.isReady);
        const identity = client.crypto.clientDeviceEd25519;
        assert.ok(identity);
        await storage.storeRoom('!synthetic:example.invalid', {algorithm: 'm.megolm.v1.aes-sha2'});
        assert.equal(
            await client.sendEvent(roomId, 'm.room.message', {msgtype: 'm.text', body}),
            '$synthetic',
        );
        assert.ok(sentContent);
        assert.equal(sentContent.algorithm, 'm.megolm.v1.aes-sha2');
        assert.ok(!JSON.stringify(sentContent).includes(body));
        client.crypto.close();
        client = undefined;
        storage.close();
        storage = undefined;
        assert.equal(existsSync(join(directory, 'bot-sdk.json')), false);
        assert.ok(
            !readFileSync(join(directory, 'metadata.sqlite')).includes(
                Buffer.from('!synthetic:example.invalid'),
            ),
        );
        assert.throws(() => new ProtectedCryptoStorage(directory, randomBytes(32)));
        storage = new ProtectedCryptoStorage(directory, key);
        assert.equal(
            (await storage.getRoom('!synthetic:example.invalid')).algorithm,
            'm.megolm.v1.aes-sha2',
        );
        await assert.rejects(storage.setDeviceId('DIFFERENT'));
        client = createClient(storage);
        await client.crypto.prepare();
        assert.equal(client.crypto.clientDeviceEd25519, identity);
        const decrypted = await client.crypto.decryptRoomEvent(
            new EncryptedRoomEvent({
                type: 'm.room.encrypted',
                event_id: '$synthetic',
                sender: userId,
                origin_server_ts: 1,
                content: sentContent,
            }),
            roomId,
        );
        assert.deepEqual(decrypted.content, {msgtype: 'm.text', body});
        assert.ok(requests.some((path) => path.endsWith('/keys/upload')));
    } finally {
        client?.crypto.close();
        storage?.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('SDK refuses native crypto without a protected-store passphrase', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-sdk-no-secret-'));
    const key = randomBytes(32);
    const storage = new ProtectedCryptoStorage(directory, key);
    const client = new MatrixClient(
        'https://example.invalid',
        'synthetic',
        new MemoryStorageProvider(),
        storage,
    );
    const requests: string[] = [];
    storage.getMachineStorePassphrase = async () => '';
    client.doRequest = async (_method: string, path: string): Promise<any> => {
        requests.push(path);
        if (path.endsWith('/account/whoami'))
            return {user_id: '@synthetic:example.invalid', device_id: 'SYNTHETIC'};
        throw new Error('Native crypto must fail before uploading keys');
    };
    try {
        await assert.rejects(client.crypto.prepare(), /protected native crypto store/);
        assert.equal(client.crypto.isReady, false);
        assert.deepEqual(requests, ['/_matrix/client/v3/account/whoami']);
    } finally {
        client.crypto.close();
        storage.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
