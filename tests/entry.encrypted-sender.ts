import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {EncryptedSender} from '../src/matrix/encrypted-sender.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';

await test('encrypted sends retain ciphertext and transaction IDs across lost replies and restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-encrypted-send-'));
    const filename = join(directory, 'portals.sqlite');
    const key = randomBytes(32);
    let store = new PortalStore(filename, key);
    const client = new MatrixClient('https://matrix.invalid', 'synthetic-token');
    let encryptions = 0;
    let sends = 0;
    let enabled = false;
    let encryptedRoom = true;
    const requests: {path: string; body: unknown}[] = [];
    // Transport behavior test only: native Megolm is exercised by the separate device-exchange probe.
    Object.defineProperty(client, 'crypto', {
        value: {
            encryptRoomEvent: async (room: string, type: string, content: unknown) => {
                assert.ok(enabled);
                assert.equal(room, '!portal:matrix.invalid');
                assert.equal(type, 'm.room.message');
                assert.deepEqual(content, {body: 'private-message-marker', msgtype: 'm.text'});
                encryptions++;
                return {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    ciphertext: `synthetic-${encryptions}`,
                    session_id: 'session',
                    sender_key: 'key',
                    device_id: 'DEVICE',
                };
            },
        },
    });
    client.doRequest = async (method, path, _query, body): Promise<any> => {
        if (method === 'GET' && path.includes('/state/m.room.encryption')) {
            return {algorithm: encryptedRoom ? 'm.megolm.v1.aes-sha2' : 'unsupported'};
        }
        assert.equal(method, 'PUT');
        assert.ok(path.includes('/send/m.room.encrypted/'));
        assert.equal(store.operation(path.split('/').at(-1)!)?.ciphertext, JSON.stringify(body));
        requests.push({path, body});
        sends++;
        if (sends === 1) throw new Error('synthetic response lost after acceptance');
        return {event_id: '$accepted'};
    };
    const intent = {
        userId: '@ghost:matrix.invalid',
        underlyingClient: client,
        enableEncryption: async () => {
            enabled = true;
        },
    };
    const body = {msgtype: 'm.text', body: 'private-message-marker'};
    let sender = new EncryptedSender(intent, store);
    try {
        await assert.rejects(
            sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', body),
            /lost/,
        );
        assert.equal(store.operation('operation-1')?.event, null);
        const wire = JSON.parse(store.operation('operation-1')!.ciphertext);
        assert.equal(
            store.isOwnEncryptedEvent(intent.userId, '!portal:matrix.invalid', wire),
            true,
        );
        assert.equal(
            store.isOwnEncryptedEvent('@other:matrix.invalid', '!portal:matrix.invalid', wire),
            false,
        );
        assert.equal(
            store.isOwnEncryptedEvent(intent.userId, '!foreign:matrix.invalid', wire),
            false,
        );
        assert.equal(
            store.isOwnEncryptedEvent(intent.userId, '!portal:matrix.invalid', {
                ...wire,
                sender_key: 'forged',
            }),
            false,
        );
        assert.equal(
            store.isOwnEncryptedEvent(intent.userId, '!portal:matrix.invalid', {
                ...wire,
                ciphertext: 'different',
            }),
            false,
        );

        store.close();
        store = new PortalStore(filename, key);
        sender = new EncryptedSender(intent, store);
        assert.equal(
            store.isOwnEncryptedEvent(intent.userId, '!portal:matrix.invalid', wire),
            true,
        );
        await assert.rejects(
            sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', {
                ...body,
                body: 'conflict',
            }),
            /conflict/,
        );
        encryptedRoom = false;
        await assert.rejects(
            sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', body),
            /unavailable/,
        );
        assert.equal(sends, 1);
        encryptedRoom = true;
        const first = sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', body);
        await assert.rejects(
            sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', {
                ...body,
                body: 'concurrent conflict',
            }),
            /conflict/,
        );
        const second = sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', body);
        assert.deepEqual(await Promise.all([first, second]), ['$accepted', '$accepted']);
        assert.equal(
            store.operation('operation-1')?.ciphertext,
            '',
            'Completed sends retain mapping, not payload',
        );
        assert.equal(encryptions, 1);
        assert.equal(sends, 2);
        assert.deepEqual(requests[0], requests[1]);
        store.close();
        store = new PortalStore(filename, key);
        sender = new EncryptedSender(intent, store);
        assert.equal(
            await sender.send('operation-1', '!portal:matrix.invalid', 'm.room.message', body),
            '$accepted',
        );
        assert.equal(sends, 2);
        encryptedRoom = false;
        await assert.rejects(
            sender.send('operation-2', '!portal:matrix.invalid', 'm.room.message', body),
            /unavailable/,
        );
        assert.equal(store.operation('operation-2'), undefined);
        await assert.rejects(
            sender.send('bad/id', '!portal:matrix.invalid', 'm.room.message', body),
            /Invalid/,
        );
        await assert.rejects(
            sender.send('operation-3', '!portal:matrix.invalid', 'm.room.message', {number: NaN}),
            /finite JSON/,
        );
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        await assert.rejects(
            sender.send('operation-3', '!portal:matrix.invalid', 'm.room.message', cycle),
            /limits/,
        );
        for (const suffix of ['', '-wal']) {
            assert.equal(
                readFileSync(filename + suffix).includes(Buffer.from('private-message-marker')),
                false,
            );
        }
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('owner projection uses bot crypto and guarded owner transport without an owner device', async () => {
    const {createOwnerBridgeIntent} = await import('../src/matrix/owner-bridge-intent.ts');
    const directory = mkdtempSync(join(tmpdir(), 'owner-bridge-send-'));
    const key = randomBytes(32);
    const store = new PortalStore(join(directory, 'portals.sqlite'), key);
    const owner = '@owner:matrix.invalid',
        room = '!portal:matrix.invalid';
    let allowed = true,
        closed = false,
        encryptions = 0,
        sends = 0;
    const botClient = new MatrixClient('https://matrix.invalid', 'bot-token');
    Object.defineProperty(botClient, 'crypto', {
        value: {
            encryptRoomEvent: async () => {
                encryptions++;
                return {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    ciphertext: 'encrypted',
                    session_id: 'bot-session',
                    sender_key: 'bot-key',
                    device_id: 'BOT',
                };
            },
        },
    });
    botClient.getRoomStateEventContent = async () => ({algorithm: 'm.megolm.v1.aes-sha2'});
    botClient.doRequest = async () => {
        throw new Error('Must not send under bot identity');
    };
    const ownerClient = new MatrixClient('https://matrix.invalid', 'as-token');
    ownerClient.getWhoAmI = async () => ({user_id: owner});
    ownerClient.doRequest = async (_method, _path, _query, body): Promise<any> => {
        sends++;
        assert.equal(body.device_id, 'BOT');
        assert.equal(store.operation('owner-message')?.sender, owner);
        if (sends === 1) throw new Error('response lost');
        return {event_id: '$owner'};
    };
    const options = {
        owner,
        ownerClient,
        bot: {
            userId: '@bot:matrix.invalid',
            underlyingClient: botClient,
            enableEncryption: async () => {},
        },
        authorize: async (candidate: string) => {
            if (!allowed || candidate !== room) throw new Error('Forbidden room');
        },
        assertOpen: () => {
            if (closed) throw new Error('closed');
        },
    };
    try {
        const intent = await createOwnerBridgeIntent(options);
        const sender = new EncryptedSender(intent, store);
        await assert.rejects(
            sender.send('owner-message', room, 'm.room.message', {body: 'test'}),
            /response lost/,
        );
        allowed = false;
        await assert.rejects(
            sender.send('owner-message', room, 'm.room.message', {body: 'test'}),
            /Forbidden/,
        );
        assert.equal(sends, 1);
        allowed = true;
        assert.equal(
            await sender.send('owner-message', room, 'm.room.message', {body: 'test'}),
            '$owner',
        );
        assert.equal(encryptions, 1);
        assert.equal(
            store.isOwnEncryptedEvent(
                owner,
                room,
                {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    ciphertext: 'encrypted',
                    session_id: 'bot-session',
                },
                '$owner',
            ),
            true,
        );
        await assert.rejects(
            intent.underlyingClient.doRequest('POST', '/_matrix/client/v3/login'),
            /only encrypted/,
        );
        await assert.rejects(
            sender.send('foreign', '!foreign:matrix.invalid', 'm.room.message', {body: 'test'}),
            /Forbidden/,
        );
        closed = true;
        await assert.rejects(intent.enableEncryption(), /closed/);
        closed = false;
        ownerClient.getWhoAmI = async () => ({user_id: '@other:matrix.invalid'});
        await assert.rejects(createOwnerBridgeIntent(options), /identity mismatch/);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
