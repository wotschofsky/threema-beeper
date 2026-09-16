import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    MatrixClient,
    MemoryStorageProvider,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProtectedCryptoStorage} from '../src/matrix/protected-storage.ts';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {createOriginalEventLoader} from '../src/matrix/original-event.ts';
await test('original retrieval decrypts native SDK ciphertext after protected-store restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'original-native-'));
    const key = randomBytes(32);
    const transport = getRequestFn();
    const owner = '@original:example.invalid';
    const room = '!original:example.invalid';
    const event = '$original-native';
    const content = {msgtype: 'm.text', body: 'original before native store restart'};
    let encrypted: any;
    let raw: any;
    let storage: ProtectedCryptoStorage | undefined;
    let client: MatrixClient | undefined;
    const open = async () => {
        storage = new ProtectedCryptoStorage(directory, key);
        client = new MatrixClient(
            'https://example.invalid',
            'synthetic',
            new MemoryStorageProvider(),
            storage,
        );
        client.doRequest = async (
            _method: string,
            path: string,
            _query?: unknown,
            payload?: unknown,
        ): Promise<any> => {
            if (path.endsWith('/account/whoami')) return {user_id: owner, device_id: 'ORIGINAL'};
            if (path.endsWith('/keys/upload'))
                return {one_time_key_counts: {signed_curve25519: 50}};
            if (path.endsWith('/keys/query')) return {device_keys: {}, failures: {}};
            if (path.endsWith('/members'))
                return {
                    chunk: [
                        {
                            type: 'm.room.member',
                            state_key: owner,
                            sender: owner,
                            content: {membership: 'join'},
                        },
                    ],
                };
            if (path.includes('/send/m.room.encrypted/')) {
                encrypted = structuredClone(payload);
                return {event_id: event};
            }
            throw new Error('Unexpected synthetic native request: ' + path);
        };
        await client.crypto.prepare();
    };
    try {
        await open();
        await storage!.storeRoom(room, {algorithm: 'm.megolm.v1.aes-sha2'});
        assert.equal(await client!.sendEvent(room, 'm.room.message', content), event);
        assert.equal(encrypted.algorithm, 'm.megolm.v1.aes-sha2');
        assert(!JSON.stringify(encrypted).includes(content.body));
        const identity = client!.crypto.clientDeviceEd25519;
        client!.crypto.close();
        client = undefined;
        storage!.close();
        storage = undefined;
        await open();
        assert.equal(client!.crypto.clientDeviceEd25519, identity);
        raw = {
            room_id: room,
            event_id: event,
            sender: owner,
            origin_server_ts: 1,
            type: 'm.room.encrypted',
            content: encrypted,
        };
        setRequestFn(async () => ({
            statusCode: 200,
            headers: {},
            body: Readable.from([Buffer.from(JSON.stringify(raw))]),
        }));
        const authorized: string[] = [];
        const loader = createOriginalEventLoader({
            client: client!,
            userId: owner,
            owner,
            authorize: async (value) => {
                authorized.push(value);
            },
        });
        assert.deepEqual(await loader(event, room), {
            event_id: event,
            room_id: room,
            sender: owner,
            type: 'm.room.message',
            encrypted: true,
            content,
        });
        assert.deepEqual(authorized, [room, room]);
        raw = {...raw, content: {...encrypted, ciphertext: 'invalid-native-ciphertext'}};
        await assert.rejects(loader(event, room), /could not be retrieved or verified/);
        raw = {...raw, room_id: '!other:example.invalid', content: encrypted};
        await assert.rejects(loader(event, raw.room_id), /could not be retrieved or verified/);
        raw = {...raw, room_id: room};
        assert.deepEqual((await loader(event, room))?.content, content);
    } finally {
        setRequestFn(transport);
        client?.crypto.close();
        storage?.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
await test('original retrieval authenticates the requested event and rejects envelope/plaintext changes', async () => {
    const transport = getRequestFn();
    const room = '!room:invalid',
        event = '$original',
        owner = '@owner:invalid';
    let raw: any = {
        room_id: room,
        event_id: event,
        sender: owner,
        type: 'm.room.encrypted',
        content: {ciphertext: 'synthetic'},
    };
    let clear: any = {
        room_id: room,
        event_id: event,
        sender: owner,
        type: 'm.room.message',
        content: {msgtype: 'm.text', body: 'original'},
    };
    let downloads = 0,
        decryptions = 0,
        authorizations = 0,
        revoke = false,
        status = 200;
    const client = {
        homeserverUrl: 'https://invalid/base',
        accessToken: 'synthetic',
        crypto: {
            isReady: true,
            decryptRoomEvent: async () => {
                decryptions++;
                return {raw: clear};
            },
        },
    } as unknown as Parameters<typeof createOriginalEventLoader>[0]['client'];
    const loader = createOriginalEventLoader({
        client,
        userId: '@bot:invalid',
        owner,
        authorize: async (value) => {
            assert.equal(value, room);
            authorizations++;
            if (revoke && authorizations % 2 === 0) throw new Error('Room authorization changed');
        },
    });
    try {
        setRequestFn(async (url: URL, input: {headers: Record<string, string>}) => {
            downloads++;
            assert.equal(
                url.pathname,
                '/base/_matrix/client/v3/rooms/!room%3Ainvalid/event/%24original',
            );
            assert.equal(url.searchParams.get('user_id'), '@bot:invalid');
            assert.deepEqual(input.headers, {Authorization: 'Bearer synthetic'});
            return {
                statusCode: status,
                headers: {},
                body: Readable.from([Buffer.from(JSON.stringify(raw))]),
            };
        });
        const result = await loader(event, room);
        assert.equal(result?.encrypted, true);
        assert.equal(result?.content.body, 'original');
        clear.content.body = 'later';
        assert.equal(result?.content.body, 'original');
        for (const change of [
            {room_id: '!other:invalid'},
            {event_id: '$other'},
            {sender: '@other:invalid'},
            {type: 'm.room.message', encrypted: true},
        ]) {
            const saved = raw;
            raw = {...raw, ...change};
            const before = decryptions;
            await assert.rejects(loader(event, room));
            assert.equal(decryptions, before);
            raw = saved;
        }
        for (const change of [
            {room_id: '!other:invalid'},
            {event_id: '$other'},
            {sender: '@other:invalid'},
            {type: 'm.room.redaction'},
        ]) {
            const saved = clear;
            clear = {...clear, ...change};
            await assert.rejects(loader(event, room));
            clear = saved;
        }
        authorizations = 0;
        revoke = true;
        await assert.rejects(loader(event, room));
        revoke = false;
        status = 404;
        assert.equal(await loader(event, room), undefined);
        status = 200;
        const before = decryptions;
        await assert.rejects(
            createOriginalEventLoader({
                client,
                userId: '@bot:invalid',
                owner,
                maximumBytes: 10,
                authorize: async () => {},
            })(event, room),
        );
        assert.equal(decryptions, before);
        const abort = new AbortController();
        abort.abort();
        const started = downloads;
        await assert.rejects(
            createOriginalEventLoader({
                client,
                userId: '@bot:invalid',
                owner,
                signal: abort.signal,
                authorize: async () => {},
            })(event, room),
        );
        assert.equal(downloads, started);
        await assert.rejects(
            createOriginalEventLoader({
                client,
                userId: '@bot:invalid',
                owner,
                timeoutMs: 10,
                authorize: async () => new Promise(() => {}),
            })(event, room),
        );
        assert.equal(downloads, started);
        let release!: (value: unknown) => void;
        let began!: () => void;
        const requested = new Promise<void>((resolve) => {
            began = resolve;
        });
        const late = new Readable({read() {}});
        setRequestFn(() => {
            began();
            return new Promise((resolve) => {
                release = resolve;
            });
        });
        const cancelled = new AbortController();
        const request = createOriginalEventLoader({
            client,
            userId: '@bot:invalid',
            owner,
            signal: cancelled.signal,
            authorize: async () => {},
        })(event, room);
        const rejected = assert.rejects(request);
        await requested;
        cancelled.abort();
        await rejected;
        release({statusCode: 200, headers: {}, body: late});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(late.destroyed, true, 'A response arriving after cancellation is closed');
    } finally {
        setRequestFn(transport);
    }
});
