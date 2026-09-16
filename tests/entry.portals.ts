import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {PortalManager} from '../src/matrix/portals.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';

await test('SDK portal creation recovers a lost response, persists mapping and rejects unencrypted or foreign rooms', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-portals-'));
    const key = randomBytes(32);
    const filename = join(directory, 'portals.sqlite');
    let store = new PortalStore(filename, key);
    const client = new MatrixClient('https://matrix.invalid', 'synthetic-token');
    const bot = '@threema_bot:matrix.invalid';
    const owner = '@owner:matrix.invalid';
    let created = false;
    let lookupOffline = true;
    let creates = 0;
    let metadataWrites = 0;
    let encryptionEnabled = 0;
    let state: {
        type: string;
        state_key: string;
        sender: string;
        content: Record<string, unknown>;
    }[] = [];
    client.doRequest = async (_method, path, _query, body): Promise<any> => {
        if (path.includes('/directory/room/')) {
            if (lookupOffline) throw new Error('synthetic directory outage');
            if (!created) throw {errcode: 'M_NOT_FOUND'};
            return {room_id: '!portal:matrix.invalid', servers: ['matrix.invalid']};
        }
        if (path.endsWith('/createRoom')) {
            assert.ok(encryptionEnabled > 0);
            assert.match(body.room_alias_name, /^sh-threema_[0-9a-f]{40}$/);
            assert.notEqual(
                body.room_alias_name,
                'sh-threema_' +
                    createHash('sha256').update('SELF1234\0c:TEST1234').digest('hex').slice(0, 40),
                'Do not recover rooms created with legacy device credentials',
            );
            creates++;
            created = true;
            assert.equal(body.visibility, 'private');
            assert.equal(body.preset, 'private_chat');
            assert.deepEqual(body.invite, [owner]);
            state = body.initial_state.map(
                (event: {type: string; state_key: string; content: Record<string, unknown>}) => ({
                    ...event,
                    sender: bot,
                }),
            );
            assert.equal(
                state.find((event) => event.type === 'm.room.encryption')!.content.algorithm,
                'm.megolm.v1.aes-sha2',
            );
            throw new Error('synthetic response lost after create succeeded');
        }
        if (path.endsWith('/state')) return state;
        if (_method === 'PUT' && path.includes('/state/')) {
            metadataWrites++;
            const parts = path.split('/state/')[1]!.split('/').map(decodeURIComponent);
            const type = parts[0]!;
            const state_key = parts[1]!;
            state = state.filter((event) => event.type !== type || event.state_key !== state_key);
            state.push({type, state_key, sender: bot, content: body});
            return {event_id: '$metadata:matrix.invalid'};
        }
        throw new Error('Unexpected synthetic SDK request');
    };
    const intent = {
        userId: bot,
        underlyingClient: client,
        enableEncryption: async () => {
            encryptionEnabled++;
        },
    };
    const options = {
        owner,
        profile: 'SELF1234',
        domain: 'matrix.invalid',
        namespace: 'sh-threema',
        protocolAvatar: 'mxc://matrix.invalid/threema',
    };
    const chat = {
        chatId: 'c:TEST1234',
        name: 'Test',
        unreadCount: 0,
        archived: false,
        pinned: false,
    };
    let manager = new PortalManager(intent, store, options);
    try {
        const denied = new PortalManager(intent, store, {
            ...options,
            assertPortalAlias: (alias) => {
                assert.match(alias, /^#sh-threema_[0-9a-f]{40}:matrix\.invalid$/);
                throw new Error('Portal alias is not exclusively registered');
            },
        });
        await assert.rejects(denied.ensure(chat), /not exclusively registered/);
        assert.equal(encryptionEnabled, 0);
        assert.equal(creates, 0);
        assert.equal(store.get(options.profile, chat.chatId), undefined);
        await assert.rejects(manager.ensure(chat));
        assert.equal(creates, 0, 'Lookup failures must not trigger speculative room creation');
        lookupOffline = false;
        await assert.rejects(manager.ensure(chat));
        assert.equal(store.get(options.profile, chat.chatId), undefined);
        assert.deepEqual(await Promise.all([manager.ensure(chat), manager.ensure(chat)]), [
            '!portal:matrix.invalid',
            '!portal:matrix.invalid',
        ]);
        assert.equal(creates, 1);
        assert.equal(
            metadataWrites,
            2,
            'Bridge metadata must be published after creation, even if initial state matches',
        );
        const bridge = state.find((event) => event.type === 'm.bridge')!;
        assert.deepEqual(
            bridge.content.network,
            {id: options.profile, displayname: 'Threema', avatar_url: options.protocolAvatar},
            'Beeper sidebar consumes network branding',
        );
        assert.equal(
            (bridge.content.channel as Record<string, unknown>)['com.beeper.message_request'],
            false,
        );
        assert.equal(bridge.content['com.beeper.room_type'], 'dm');
        assert.equal(bridge.content['com.beeper.room_type.v2'], 'dm');
        assert.deepEqual(
            state.find((event) => event.type === 'uk.half-shot.bridge')?.content,
            bridge.content,
        );
        store.close();
        store = new PortalStore(filename, key);
        manager = new PortalManager(intent, store, options);
        assert.equal(await manager.ensure(chat), '!portal:matrix.invalid');
        assert.equal(
            metadataWrites,
            2,
            'An already recognized unchanged room needs no new state events',
        );
        // Existing rooms from before the fix are repaired without creating another room.
        state = state.filter((event) => event.type !== 'uk.half-shot.bridge');
        delete state.find((event) => event.type === 'm.bridge')!.content['com.beeper.room_type'];
        state.find((event) => event.type === 'm.bridge')!.content.network = {id: options.profile};
        await manager.ensure(chat);
        assert.equal(
            state.find((event) => event.type === 'm.bridge')!.content['com.beeper.room_type'],
            'dm',
        );
        assert.deepEqual(
            state.find((event) => event.type === 'uk.half-shot.bridge')?.content,
            state.find((event) => event.type === 'm.bridge')!.content,
        );
        assert.equal(creates, 1);
        assert.deepEqual(state.find((event) => event.type === 'm.bridge')!.content.network, {
            id: options.profile,
            displayname: 'Threema',
            avatar_url: options.protocolAvatar,
        });
        state.find((event) => event.type === 'm.room.encryption')!.content.algorithm = 'plaintext';
        await assert.rejects(manager.ensure(chat), /verification failed/);
        state.find((event) => event.type === 'm.room.encryption')!.content.algorithm =
            'm.megolm.v1.aes-sha2';
        state.find((event) => event.type === 'm.bridge')!.sender = '@attacker:matrix.invalid';
        await assert.rejects(manager.ensure(chat), /verification failed/);
        assert.equal(creates, 1);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('offline portal replacement preserves history and refuses stale or unfinished changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-replace-'));
    const key = randomBytes(32);
    const filename = join(directory, 'portals.sqlite');
    let store = new PortalStore(filename, key);
    const profile = 'SELF1234',
        chat = 'c:TEST1234';
    try {
        store.bind(profile, chat, '!old:matrix.invalid');
        store.bindOwnerEcho({
            profile,
            chat,
            message: 'm:0100000000000000',
            room: '!old:matrix.invalid',
            sender: '@owner:matrix.invalid',
            root: '$old',
            latest: '$old',
            digest: 'old',
        });
        assert.throws(
            () =>
                store.replaceRoom(profile, chat, '!foreign:matrix.invalid', '!new:matrix.invalid'),
            /changed/,
        );
        store.prepareProjection({
            id: 'pending',
            profile,
            chat,
            message: 'm:0200000000000000',
            room: '!old:matrix.invalid',
            sender: '@owner:matrix.invalid',
            fingerprint: 'f',
            digest: 'd',
            root: null,
            content: '{}',
        });
        assert.throws(
            () => store.replaceRoom(profile, chat, '!old:matrix.invalid', '!new:matrix.invalid'),
            /unfinished/,
        );
        store.prepareOperation({
            id: 'pending',
            sender: '@owner:matrix.invalid',
            room: '!old:matrix.invalid',
            digest: 'd',
            ciphertext: '{}',
        });
        store.completeOperation('pending', '$second');
        store.finishProjection('pending', '$second');
        store.bind(profile, 'c:OTHER123', '!occupied:matrix.invalid');
        assert.throws(() =>
            store.replaceRoom(profile, chat, '!old:matrix.invalid', '!occupied:matrix.invalid'),
        );
        assert.equal(store.get(profile, chat), '!old:matrix.invalid');
        store.replaceRoom(profile, chat, '!old:matrix.invalid', '!new:matrix.invalid');
        store.replaceRoom(profile, chat, '!old:matrix.invalid', '!new:matrix.invalid');
        store.close();
        store = new PortalStore(filename, key);
        assert.equal(store.get(profile, chat), '!new:matrix.invalid');
        assert.equal(store.portalForRoom('!old:matrix.invalid'), undefined);
        assert.equal(
            store.messageMapping(profile, chat, 'm:0100000000000000')?.room,
            '!old:matrix.invalid',
        );
        assert.equal(store.messageForEvent(profile, chat, '$old'), 'm:0100000000000000');
        assert.equal(store.operation('pending')?.event, '$second');
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('retiring empty mappings refuses saved messages and ciphertext and survives restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-empty-portal-'));
    const key = randomBytes(32),
        file = join(directory, 'portals.sqlite');
    let store = new PortalStore(file, key);
    try {
        store.bind('SELF1234', 'c:EMPTY123', '!empty:matrix.invalid');
        assert.throws(
            () => store.retireEmptyRoom('SELF1234', 'c:EMPTY123', '!wrong:matrix.invalid'),
            /changed/,
        );
        store.retireEmptyRoom('SELF1234', 'c:EMPTY123', '!empty:matrix.invalid');
        store.retireEmptyRoom('SELF1234', 'c:EMPTY123', '!empty:matrix.invalid');
        store.bind('SELF1234', 'c:TEXT1234', '!history:matrix.invalid');
        store.bindOwnerEcho({
            profile: 'SELF1234',
            chat: 'c:TEXT1234',
            message: 'm:0100000000000000',
            room: '!history:matrix.invalid',
            sender: '@owner:matrix.invalid',
            root: '$history',
            latest: '$history',
            digest: 'd',
        });
        assert.throws(
            () => store.retireEmptyRoom('SELF1234', 'c:TEXT1234', '!history:matrix.invalid'),
            /history/,
        );
        store.bind('SELF1234', 'c:QUEUE123', '!queued:matrix.invalid');
        store.prepareOperation({
            id: 'pending',
            room: '!queued:matrix.invalid',
            sender: '@owner:matrix.invalid',
            digest: 'd',
            ciphertext: '{}',
        });
        assert.throws(
            () => store.retireEmptyRoom('SELF1234', 'c:QUEUE123', '!queued:matrix.invalid'),
            /history/,
        );
        store.close();
        store = new PortalStore(file, key);
        assert.equal(store.get('SELF1234', 'c:EMPTY123'), undefined);
        assert.equal(store.get('SELF1234', 'c:TEXT1234'), '!history:matrix.invalid');
        assert.equal(store.get('SELF1234', 'c:QUEUE123'), '!queued:matrix.invalid');
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
