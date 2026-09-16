import {ProtectedCryptoStorage} from '../src/matrix/protected-storage.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MessageDelivery} from '../src/matrix/message-delivery.ts';
import {EncryptedSender} from '../src/matrix/encrypted-sender.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProtectedAppserviceStorage} from '../src/matrix/appservice-storage.ts';
import {prepareOwnerEncryption} from '../src/matrix/owner-encryption.ts';

await test('owner encryption verifies identity and preserves a dedicated device across interrupted setup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-crypto-')),
        key = randomBytes(32);
    let storage = new ProtectedAppserviceStorage(directory, key);
    const owner = '@owner:invalid';
    let identity = '@other:invalid',
        device = 'DAILY',
        fail = true;
    const devices: string[] = [];
    const intent = {
        userId: owner,
        underlyingClient: {getWhoAmI: async () => ({user_id: identity, device_id: device})},
        enableEncryption: async (requested: string) => {
            assert(storage.isUserRegistered(owner), 'No registration of the real account');
            devices.push(requested);
            if (fail) throw new Error('Interrupted setup');
            device = requested;
            await storage.cryptoForUser(owner).setDeviceId(requested);
        },
    };
    try {
        await assert.rejects(
            prepareOwnerEncryption({owner, storage, intent}),
            /could not be verified/,
        );
        assert.equal(storage.isUserRegistered(owner), false);
        assert.equal(devices.length, 0);
        identity = owner;
        await assert.rejects(prepareOwnerEncryption({owner, storage, intent}), /Interrupted setup/);
        assert.notEqual(devices[0], 'DAILY');
        storage.close();
        storage = new ProtectedAppserviceStorage(directory, key);
        fail = false;
        await prepareOwnerEncryption({owner, storage, intent});
        assert.equal(devices[1], devices[0], 'Interrupted setup reuses its durable bridge device');
        storage
            .storageForUser(owner)
            .storeValue('ownerBridgeDevice', 'THREEMA_00000000-0000-0000-0000-000000000000');
        await assert.rejects(prepareOwnerEncryption({owner, storage, intent}), /not bridge-owned/);
        assert.equal(devices.length, 2, 'Conflicting crypto state is never reset');
        await assert.rejects(
            prepareOwnerEncryption({owner: '@foreign:invalid', storage, intent}),
            /Invalid owner/,
        );
    } finally {
        storage.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('native owner replacements share keys with a second device and survive both device restarts', async () => {
    const {Bridge, AppServiceRegistration} = await import(
        '../.local/sources/matrix-appservice-bridge/lib/index.js'
    );
    const {
        getRequestFn,
        setRequestFn,
        LogService,
        EncryptedRoomEvent,
        MatrixClient,
        MemoryStorageProvider,
    } = await import(
        '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js'
    );
    LogService.setLogger({info() {}, warn() {}, error() {}, debug() {}, trace() {}});
    const directory = mkdtempSync(join(tmpdir(), 'owner-native-')),
        key = randomBytes(32);
    const owner = '@owner:example.invalid';
    const savedRequest = getRequestFn();
    let login: {user_id: string; device_id: string; access_token: string} | undefined;
    let logins = 0;
    const keys: string[] = [];
    const published = new Map<string, any>();
    const oneTime = new Map<string, Record<string, unknown>>();
    const toRecipient: any[] = [];
    let claims = 0,
        shared = 0;
    let receiverStore: ProtectedCryptoStorage | undefined;
    let receiver: InstanceType<typeof MatrixClient> | undefined;

    const room = '!owner:example.invalid',
        profile = 'SELF1234',
        chat = 'c:TEST1234';
    const wires = new Map<string, Record<string, unknown>>();
    let loseReply = true;
    const attachment = {
        url: 'mxc://example.invalid/attachment',
        v: 'v2',
        key: {k: 'synthetic'},
        iv: 'synthetic',
        hashes: {sha256: 'synthetic'},
    };
    const message: NormalizedNodeMessage = {
        direction: 'outbound',
        senderIdentity: profile,
        chatId: chat,
        messageId: 'm:0100000000000000',
        createdAt: new Date(1000),
        ordinal: 1n,
        reactions: [],
        content: {type: 'text', text: 'private owner edit'},
    };

    setRequestFn(
        async (
            url: URL,
            options: {method: string; headers: Record<string, string>; body?: string | Buffer},
        ) => {
            assert.equal(url.origin, 'https://example.invalid');
            const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
            const token = (
                options.headers.Authorization ??
                options.headers.authorization ??
                ''
            ).replace(/^Bearer /, '');
            let response: unknown;
            if (url.pathname.endsWith('/account/whoami')) {
                if (token !== 'synthetic-recipient')
                    assert.equal(url.searchParams.get('user_id'), owner);
                response =
                    token === 'synthetic-recipient'
                        ? {user_id: owner, device_id: 'RECIPIENT'}
                        : token === 'synthetic-owner-token'
                          ? login
                          : {user_id: owner, device_id: 'DAILY'};
            } else if (url.pathname.includes('/devices/')) {
                throw new Error('Synthetic server requires application-service login');
            } else if (url.pathname.endsWith('/login')) {
                assert.equal(body.type, 'm.login.application_service');
                assert.equal(body.identifier.user, owner);
                assert.match(body.device_id, /^THREEMA_/);
                logins++;
                login = {
                    user_id: owner,
                    device_id: body.device_id,
                    access_token: 'synthetic-owner-token',
                };
                response = login;
            } else if (url.pathname.endsWith('/keys/upload')) {
                const device = token === 'synthetic-recipient' ? 'RECIPIENT' : login!.device_id;
                if (body.device_keys) {
                    published.set(device, body.device_keys);
                    if (device !== 'RECIPIENT')
                        keys.push(body.device_keys.keys[`ed25519:${device}`]);
                }
                const available = oneTime.get(device) ?? {};
                Object.assign(available, body.one_time_keys ?? {});
                oneTime.set(device, available);
                response = {
                    one_time_key_counts: {signed_curve25519: Object.keys(available).length},
                };
            } else if (url.pathname.endsWith('/keys/query')) {
                response = {device_keys: {[owner]: Object.fromEntries(published)}, failures: {}};
            } else if (url.pathname.endsWith('/keys/claim')) {
                const result: Record<string, unknown> = {};
                for (const [device, algorithm] of Object.entries(body.one_time_keys[owner])) {
                    const available = oneTime.get(device)!;
                    const id = Object.keys(available).find((id) => id.startsWith(`${algorithm}:`));
                    assert.ok(id, 'Recipient must have an uploaded native one-time key');
                    result[device] = {[id]: available[id]};
                    delete available[id];
                    claims++;
                }
                response = {one_time_keys: {[owner]: result}, failures: {}};
            } else if (url.pathname.includes('/sendToDevice/')) {
                assert.equal(token, 'synthetic-owner-token');
                assert.ok(url.pathname.includes('/sendToDevice/m.room.encrypted/'));
                for (const [device, content] of Object.entries(body.messages[owner])) {
                    assert.equal(device, 'RECIPIENT');
                    toRecipient.push({sender: owner, type: 'm.room.encrypted', content});
                    shared++;
                }
                response = {};
            } else if (url.pathname.includes('/send/m.room.encrypted/')) {
                assert.equal(token, 'synthetic-owner-token');
                assert.equal(url.searchParams.get('user_id'), owner);
                const id = url.pathname.split('/').at(-1)!;
                if (wires.has(id))
                    assert.deepEqual(body, wires.get(id), 'Retry preserves native ciphertext');
                else wires.set(id, body);
                assert.equal(JSON.stringify(body).includes('private owner'), false);
                if (loseReply) {
                    loseReply = false;
                    throw new Error('Lost native owner response');
                }
                response = {event_id: `$${id}`};
            } else if (url.pathname.includes('/state/m.room.encryption/')) {
                response = {algorithm: 'm.megolm.v1.aes-sha2'};
            } else if (url.pathname.includes('/state/m.room.history_visibility/')) {
                response = {history_visibility: 'shared'};
            } else if (url.pathname.endsWith('/members')) {
                response = {
                    chunk: [
                        {
                            type: 'm.room.member',
                            state_key: owner,
                            sender: owner,
                            event_id: '$membership',
                            content: {membership: 'join'},
                        },
                    ],
                };
            } else if (url.pathname.endsWith('/joined_rooms')) {
                response = {joined_rooms: []};
            } else {
                assert.fail(`Unexpected owner SDK request: ${options.method} ${url.pathname}`);
            }
            return {
                statusCode: 200,
                headers: {'content-type': 'application/json'},
                body: {bytes: async () => Buffer.from(JSON.stringify(response))},
            };
        },
    );
    const openReceiver = async () => {
        receiverStore = new ProtectedCryptoStorage(join(directory, 'recipient'), key);
        receiver = new MatrixClient(
            'https://example.invalid',
            'synthetic-recipient',
            new MemoryStorageProvider(),
            receiverStore,
        );
        await receiver.crypto.prepare();
    };
    try {
        await openReceiver();
        let identityKey: string | undefined;
        for (let restart = 0; restart < 2; restart++) {
            const storage = new ProtectedAppserviceStorage(directory, key);
            const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
            const registration = AppServiceRegistration.fromObject({
                id: 'owner-fixture',
                url: 'http://127.0.0.1:29339',
                as_token: 'synthetic-as',
                hs_token: 'synthetic-hs',
                sender_localpart: 'bot',
                namespaces: {users: [{regex: '^@owner:example\\.invalid$', exclusive: false}]},
            })!;
            const bridge = new Bridge({
                domain: 'example.invalid',
                homeserverUrl: 'https://example.invalid',
                registration,
                disableStores: true,
                controller: {onEvent() {}},
                nativeEncryption: {
                    storage,
                    cryptoStorage: {storageForUser: (id) => storage.cryptoForUser(id)},
                },
            });
            let intent: ReturnType<typeof bridge.getIntent>['botSdkIntent'] | undefined;
            try {
                await bridge.initialise();
                intent = bridge.getIntent(owner).botSdkIntent;
                await prepareOwnerEncryption({owner, storage, intent});
                assert.equal(intent.underlyingClient.crypto.isReady, true);
                assert.equal(await storage.cryptoForUser(owner).getDeviceId(), login!.device_id);
                assert.equal(logins, 1, 'Restart reuses the saved appservice session');
                if (!restart) identityKey = intent.underlyingClient.crypto.clientDeviceEd25519;
                else assert.equal(intent.underlyingClient.crypto.clientDeviceEd25519, identityKey);
                assert.equal(keys[0], identityKey);
                assert.ok(identityKey, 'Native crypto uploaded a device key');
                portals.bind(profile, chat, room);
                portals.bindOwnerEcho({
                    profile,
                    chat,
                    message: message.messageId,
                    room,
                    sender: owner,
                    root: '$owner-original',
                    latest: '$owner-original',
                    digest: 'original',
                });
                const delivery = new MessageDelivery(portals, async () => ({
                    msgtype: 'm.file',
                    filename: 'file.bin',
                    body: 'private owner caption',
                    file: attachment,
                    info: {size: 3},
                }));
                const sender = new EncryptedSender(intent, portals);
                if (!restart) {
                    await assert.rejects(
                        delivery.deliver(
                            profile,
                            room,
                            owner,
                            sender,
                            message,
                            'native-owner-text',
                        ),
                        /Lost native owner response/,
                    );
                    assert.equal(portals.operation('native-owner-text')!.event, null);
                } else {
                    await delivery.deliver(
                        profile,
                        room,
                        owner,
                        sender,
                        message,
                        'native-owner-text',
                    );
                    assert.equal(
                        portals.messageMapping(profile, chat, message.messageId)!.root,
                        '$owner-original',
                    );
                    const file: NormalizedNodeMessage = {
                        ...message,
                        messageId: 'm:0200000000000000',
                        content: {
                            type: 'file',
                            mimeType: 'application/octet-stream',
                            fileName: 'file.bin',
                            byteSize: 3,
                            caption: 'private owner caption',
                        },
                    };
                    portals.bindOwnerEcho({
                        profile,
                        chat,
                        message: file.messageId,
                        room,
                        sender: owner,
                        root: '$file-original',
                        latest: '$file-original',
                        digest: 'original-file',
                    });
                    await delivery.deliver(
                        profile,
                        room,
                        owner,
                        sender,
                        file,
                        'native-owner-caption',
                    );
                    assert.ok(claims > 0 && shared > 0, 'Native Olm session keys must be shared');
                    assert.notEqual(receiver!.crypto.clientDeviceEd25519, identityKey);
                    await assert.rejects(
                        receiver!.crypto.decryptRoomEvent(
                            new EncryptedRoomEvent({
                                type: 'm.room.encrypted',
                                room_id: room,
                                event_id: '$native-owner-text',
                                sender: owner,
                                origin_server_ts: 1000,
                                content: wires.get('native-owner-text')!,
                            }),
                            room,
                        ),
                        'Recipient cannot decrypt before receiving the room key',
                    );
                    await receiver!.crypto.updateSyncData(toRecipient.splice(0), {}, [], [], []);
                    receiver!.crypto.close();
                    receiverStore!.close();
                    await openReceiver();
                    for (const [id, wire] of wires) {
                        const clear = await receiver!.crypto.decryptRoomEvent(
                            new EncryptedRoomEvent({
                                type: 'm.room.encrypted',
                                room_id: room,
                                event_id: `$${id}`,
                                sender: owner,
                                origin_server_ts: 1000,
                                content: wire,
                            }),
                            room,
                        );
                        const content = clear.raw.content as Record<string, any>;
                        assert.deepEqual(content['m.relates_to'], {
                            rel_type: 'm.replace',
                            event_id:
                                id === 'native-owner-text' ? '$owner-original' : '$file-original',
                        });
                        assert.equal(
                            content['m.new_content'].body,
                            id === 'native-owner-text'
                                ? 'private owner edit'
                                : 'private owner caption',
                        );
                        if (id === 'native-owner-caption')
                            assert.deepEqual(content['m.new_content'].file, attachment);
                        assert.equal(portals.operation(id)!.ciphertext, '');
                        assert.equal(
                            portals.isOwnEncryptedEvent(owner, room, wire, `$${id}`),
                            true,
                        );
                        assert.equal(
                            portals.isOwnEncryptedEvent(owner, room, wire, '$foreign-event'),
                            false,
                        );
                    }
                    assert.equal(wires.size, 2);
                }
            } finally {
                intent?.underlyingClient.crypto.close();
                await bridge.close();
                storage.close();
                portals.close();
            }
        }
    } finally {
        receiver?.crypto.close();
        receiverStore?.close();
        setRequestFn(savedRequest);
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('owner session recovery renews only rejected tokens and preserves encrypted device storage', async () => {
    const {recoverOwnerSession} = await import('../src/matrix/owner-session.ts');
    const directory = mkdtempSync(join(tmpdir(), 'owner-session-'));
    const key = randomBytes(32);
    let storage = new ProtectedAppserviceStorage(directory, key);
    const owner = '@owner:example.invalid';
    const device = 'THREEMA_00000000-0000-0000-0000-000000000001';
    let mode = 'expired';
    let logins = 0;
    const whoami = async (token: string) => {
        if (mode === 'network') throw new Error('offline');
        if (mode === 'forbidden') throw {statusCode: 403, errcode: 'M_FORBIDDEN'};
        if (mode === 'wrong-owner') return {user_id: '@other:example.invalid', device_id: device};
        if (mode === 'wrong-device') return {user_id: owner, device_id: 'DAILY'};
        if (token === 'expired') throw {statusCode: 401, errcode: 'M_UNKNOWN_TOKEN'};
        return {user_id: owner, device_id: device};
    };
    const run = () =>
        recoverOwnerSession({
            owner,
            device,
            storage: storage.storageForUser(owner),
            whoami,
            login: async (requested) => {
                logins++;
                assert.equal(requested, device);
                return {
                    user_id: owner,
                    device_id: mode === 'bad-login' ? 'DAILY' : device,
                    access_token: 'renewed',
                };
            },
        });
    try {
        await storage.cryptoForUser(owner).setDeviceId(device);
        await storage.storageForUser(owner).storeValue('ownerBridgeDevice', device);
        await storage.storageForUser(owner).storeValue('accessToken', 'expired');
        await run();
        assert.equal(logins, 1);
        storage.close();
        storage = new ProtectedAppserviceStorage(directory, key);
        assert.equal(await storage.storageForUser(owner).readValue('accessToken'), 'renewed');
        assert.equal(await storage.cryptoForUser(owner).getDeviceId(), device);
        assert.equal(await storage.storageForUser(owner).readValue('ownerBridgeDevice'), device);
        await run();
        assert.equal(logins, 1, 'Valid restart must not renew');
        for (mode of ['network', 'forbidden', 'wrong-owner', 'wrong-device']) {
            await assert.rejects(run());
            assert.equal(logins, 1, 'Ambiguous failures must not renew');
            assert.equal(await storage.storageForUser(owner).readValue('accessToken'), 'renewed');
        }
        mode = 'bad-login';
        await storage.storageForUser(owner).storeValue('accessToken', 'expired');
        await assert.rejects(run(), /unexpected identity/);
        assert.equal(await storage.storageForUser(owner).readValue('accessToken'), 'expired');
    } finally {
        storage.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
