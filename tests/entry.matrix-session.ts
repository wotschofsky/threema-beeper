import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {AppServiceRegistration} from '../.local/sources/matrix-appservice-bridge/lib/index.js';
import {
    LogService,
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {openMatrixSession, type MatrixSession} from '../src/service/matrix-session.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {ghostUserId} from '../src/matrix/ghosts.ts';
import {managementRoomState} from '../src/management/room-policy.ts';

await test('native Matrix session preserves routed HTTP endpoints, device identity and profile boundaries', async () => {
    LogService.setLogger({info() {}, warn() {}, error() {}, debug() {}, trace() {}});
    const directory = await mkdtemp(join(tmpdir(), 'threema-matrix-session-'));
    const key = randomBytes(32),
        portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const profile = 'SELF1234',
        domain = 'example.invalid',
        botUserId = '@bridge_bot:example.invalid';
    const ghostId = ghostUserId(profile, 'TEST1234', domain, 'sh-threema');
    const managementId = '!management:example.invalid';
    const owner = '@owner:example.invalid';
    const managementState = [
        ...managementRoomState({profile, owner, bot: botUserId}).map((event) => ({
            ...event,
            sender: botUserId,
        })),
        ...[owner, botUserId].map((user) => ({
            type: 'm.room.member',
            state_key: user,
            sender: botUserId,
            content: {membership: 'join'},
        })),
    ];
    const identities = new Map<string, {user_id: string; device_id: string}>();
    let ghostJoined = true,
        ghostLogins = 0;
    let ownerLogins = 0;
    let logins = 0,
        offline = false,
        membershipFetchFailure = false;
    const original = getRequestFn();
    const endpoint = 'https://example.invalid/_hungryserv/owner';
    const requested = new Set<string>();
    let originalEnvelope: unknown;
    let originalDownloads = 0;
    const respond = async function (
        _method: string,
        path: string,
        _query: unknown,
        body: any,
        accessToken: string,
    ): Promise<any> {
        if (path.endsWith('/createRoom')) {
            assert.equal(
                accessToken,
                'synthetic-as-token',
                'room creation must retain appservice authorization for event routing',
            );
            assert.equal((_query as URLSearchParams).get('user_id'), botUserId);
            return {room_id: '!created:example.invalid'};
        }
        if (path.endsWith('/state')) {
            if (membershipFetchFailure) throw new Error('synthetic membership lookup failed');
            return managementState;
        }
        if (path.includes('/state/m.room.encryption/')) return {algorithm: 'm.megolm.v1.aes-sha2'};
        if (path.includes('/state/m.room.history_visibility/'))
            return {history_visibility: 'shared'};
        if (path.endsWith('/members')) return {}; // Beeper lacks this snapshot endpoint.
        if (path.endsWith('/joined_rooms')) {
            assert.notEqual(
                identities.get(accessToken)?.user_id,
                owner,
                'Owner bridge devices cannot enumerate global joined rooms on Beeper',
            );
            return {
                joined_rooms:
                    identities.get(accessToken)?.user_id === ghostId && ghostJoined
                        ? ['!owned:example.invalid']
                        : [],
            };
        }
        if (path.endsWith('/register')) {
            assert.notEqual(body.username, 'owner');
            return {user_id: `@${body.username}:${domain}`};
        }
        if (path.endsWith('/devices')) throw new Error('Device discovery must not be used');
        if (path.includes('/devices/'))
            throw new Error('synthetic device masquerading unsupported');
        if (path.endsWith('/keys/query')) return {device_keys: {}, failures: {}};
        if (path.endsWith('/login') && _method === 'GET')
            return {flows: [{type: 'm.login.application_service'}]};
        if (path.endsWith('/login')) {
            const user = body.identifier.user;
            assert.ok(user === botUserId || user === ghostId || user === owner);
            if (user === botUserId) logins++;
            else if (user === ghostId) ghostLogins++;
            else ownerLogins++;
            const token =
                user === botUserId
                    ? 'synthetic-user-token'
                    : user === ghostId
                      ? 'synthetic-ghost-token'
                      : 'synthetic-owner-token';
            const identity = {user_id: user, device_id: body.device_id};
            identities.set(token, identity);
            return {...identity, access_token: token};
        }
        if (path.endsWith('/account/whoami')) {
            if (offline) throw new Error('synthetic offline');
            if (
                accessToken === 'synthetic-as-token' &&
                (_query as URLSearchParams).get('user_id') === owner
            )
                return {user_id: owner, device_id: 'DAILY'};
            assert.ok(identities.has(accessToken));
            return identities.get(accessToken);
        }
        if (path.endsWith('/receipt/m.read/%24fixture')) return {};
        if (path === '/_matrix/media/v3/upload')
            return {content_uri: 'mxc://example.invalid/fixture'};
        if (path.endsWith('/keys/upload')) return {one_time_key_counts: {signed_curve25519: 50}};
        throw new Error('Unexpected synthetic Matrix request');
    };
    setRequestFn(
        async (
            url: URL,
            options: {method: string; headers: Record<string, string>; body?: string | Buffer},
        ) => {
            assert.equal(url.origin, 'https://example.invalid');
            assert.ok(
                url.pathname.startsWith('/_hungryserv/owner/_matrix/'),
                'SDK must preserve the per-owner API route',
            );
            const path = url.pathname.slice('/_hungryserv/owner'.length);
            if (path.endsWith('/event/%24original')) {
                originalDownloads++;
                assert.equal(url.searchParams.get('user_id'), botUserId);
                assert.equal(options.headers.Authorization, 'Bearer synthetic-user-token');
                return {
                    statusCode: 200,
                    headers: {},
                    body: Readable.from([Buffer.from(JSON.stringify(originalEnvelope))]),
                };
            }
            requested.add(path);
            const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
            const token = (
                options.headers.Authorization ??
                options.headers.authorization ??
                ''
            ).replace(/^Bearer /, '');
            const value = await respond(options.method, path, url.searchParams, body, token);
            return {
                statusCode: 200,
                headers: {'content-type': 'application/json'},
                body: {bytes: async () => Buffer.from(JSON.stringify(value))},
            };
        },
    );
    const registration = AppServiceRegistration.fromObject({
        id: 'fixture',
        url: 'http://127.0.0.1:29339',
        as_token: 'synthetic-as-token',
        hs_token: 'synthetic-hs-token',
        sender_localpart: 'bridge_bot',
        namespaces: {
            users: [
                {regex: '^@sh-threema_.*_5445535431323334:example.invalid$', exclusive: true},
                {regex: '^@sh-threema_.*_5445535435363738:example.invalid$', exclusive: false},
            ],
            aliases: [],
            rooms: [],
        },
    })!;
    let session: MatrixSession | undefined;
    const open = () =>
        openMatrixSession({
            registration,
            domain,
            botUserId,
            profile,
            namespace: 'sh-threema',
            owner,
            homeserver: endpoint,
            directory: join(directory, 'crypto'),
            key,
            portals,
        });
    try {
        session = await open();
        assert.equal(session.ready(), true);
        assert.equal(
            await session.bot.underlyingClient.createRoom({
                visibility: 'private',
                initial_state: [],
            }),
            '!created:example.invalid',
        );
        assert.throws(() => session!.getIntent(owner), /outside the active profile/);
        const [ownerClient, sameOwnerClient] = await Promise.all([
            session.ownerIntent(),
            session.ownerIntent(),
        ]);
        assert.equal(ownerClient, sameOwnerClient);
        assert.equal(ownerClient.userId, owner);
        assert.equal('joinRoom' in ownerClient, false);
        assert.equal('leaveRoom' in ownerClient, false);
        const ownerDevice = ownerClient.underlyingClient.crypto.clientDeviceId;
        const ownerKey = ownerClient.underlyingClient.crypto.clientDeviceEd25519;
        assert.match(ownerDevice, /^THREEMA_/);
        assert.equal(ownerLogins, 1);

        await session.bot.underlyingClient.sendReadReceipt('!room:example.invalid', '$fixture');
        assert.equal(
            await session.bot.underlyingClient.uploadContent(
                Buffer.from('synthetic ciphertext'),
                'application/octet-stream',
                'fixture',
            ),
            'mxc://example.invalid/fixture',
        );
        assert.ok([...requested].some((path) => path.endsWith('/login')));
        assert.ok([...requested].some((path) => path.endsWith('/keys/upload')));
        await assert.rejects(
            session.registerManagementRoom(managementId, '@other:example.invalid'),
        );
        await session.registerManagementRoom(managementId, owner);
        await assert.rejects(session.registerManagementRoom('!different:example.invalid', owner));
        const managementCrypto = session.bot.underlyingClient.crypto;
        const encryptedManagement = await managementCrypto.encryptRoomEvent(
            managementId,
            'm.room.message',
            {
                msgtype: 'm.notice',
                body: 'Synthetic management round trip',
            },
        );
        const clearManagement: any[] = [];
        await session.decode(
            {
                events: [
                    {
                        type: 'm.room.encrypted',
                        room_id: managementId,
                        event_id: '$management',
                        sender: botUserId,
                        origin_server_ts: Date.now(),
                        content: encryptedManagement,
                    },
                ],
            },
            async (event) => {
                clearManagement.push(event);
            },
        );
        assert.equal(clearManagement[0].encrypted, true);
        assert.equal(clearManagement[0].content.body, 'Synthetic management round trip');
        portals.prepareOperation({
            id: 'pending-native-echo',
            sender: botUserId,
            room: managementId,
            digest: 'synthetic-digest',
            ciphertext: JSON.stringify(encryptedManagement),
        });
        await session.decode(
            {
                events: [
                    {
                        type: 'm.room.encrypted',
                        room_id: managementId,
                        event_id: '$pending-echo',
                        sender: botUserId,
                        origin_server_ts: Date.now(),
                        content: encryptedManagement,
                    },
                ],
            },
            async () => assert.fail('Persisted ciphertext must not become a new inbox event'),
        );
        assert.equal(
            portals.operation('pending-native-echo')!.event,
            null,
            'Suppressing an echo does not fabricate an HTTP send acknowledgement',
        );
        portals.completeOperation('pending-native-echo', '$confirmed-echo');
        assert.equal(portals.operation('pending-native-echo')!.ciphertext, '');
        await session.decode(
            {
                events: [
                    {
                        type: 'm.room.encrypted',
                        room_id: managementId,
                        event_id: '$confirmed-echo',
                        sender: botUserId,
                        origin_server_ts: Date.now(),
                        content: encryptedManagement,
                    },
                ],
            },
            async () => assert.fail('Acknowledged own event must not enter the inbox'),
        );

        assert.equal(
            await session.handleState({
                type: 'm.room.encryption',
                state_key: '',
                room_id: managementId,
                event_id: '$management-encryption',
                sender: botUserId,
                content: {algorithm: 'm.megolm.v1.aes-sha2'},
            }),
            true,
        );

        portals.bind(profile, 'c:TEST1234', '!owned:example.invalid');
        const crypto = session.bot.underlyingClient.crypto;
        const originalRoomEvent = crypto.onRoomEvent.bind(crypto);
        let tracked = 0,
            emitted = 0;
        crypto.onRoomEvent = async (roomId, event) => {
            tracked++;
            await originalRoomEvent(roomId, event);
        };
        const membership = {
            type: 'm.room.member',
            room_id: '!owned:example.invalid',
            event_id: '$membership',
            sender: '@owner:example.invalid',
            state_key: '@joined:example.invalid',
            content: {membership: 'join'},
        };
        await session.decode({events: [membership]}, async () => {
            emitted++;
        });
        assert.equal(tracked, 1);
        assert.equal(emitted, 1);
        await session.decode(
            {events: [{...membership, room_id: '!unowned:example.invalid'}]},
            async () => {},
        );
        assert.equal(tracked, 1, 'Foreign state must not reach the active profile crypto tracker');
        crypto.onRoomEvent = async () => {
            throw new Error('synthetic tracker failure');
        };
        await assert.rejects(
            session.decode({events: [membership]}, async () => {
                emitted++;
            }),
            /tracker failure/,
        );
        assert.equal(emitted, 1, 'State must not be published after tracker failure');
        crypto.onRoomEvent = originalRoomEvent;
        const encryptionState = {
            ...membership,
            type: 'm.room.encryption',
            state_key: '',
            content: {algorithm: 'm.megolm.v1.aes-sha2'},
        };
        assert.equal(await session.handleState(membership), false);
        assert.equal(
            await session.handleState({...encryptionState, room_id: '!unowned:example.invalid'}),
            false,
        );
        membershipFetchFailure = true;
        await assert.rejects(session.handleState(encryptionState), /membership lookup failed/);
        await assert.rejects(
            session.decode({events: [encryptionState]}, async () => {
                emitted++;
            }),
            /membership lookup failed/,
        );
        assert.equal(emitted, 1);
        membershipFetchFailure = false;
        await session.decode({events: [encryptionState]}, async () => {
            emitted++;
        });
        assert.equal(emitted, 2);
        assert.equal(await session.handleState(encryptionState), true);

        const nativeGhost = session.getIntent(ghostId);
        await nativeGhost.enableEncryption();
        const ghostIdentity = nativeGhost.underlyingClient.crypto.clientDeviceEd25519;
        assert.equal(ghostLogins, 1);
        let ghostEvents = 0;
        const ghostCrypto = nativeGhost.underlyingClient.crypto;
        const trackGhost = ghostCrypto.onRoomEvent.bind(ghostCrypto);
        ghostCrypto.onRoomEvent = async (room, event) => {
            ghostEvents++;
            await trackGhost(room, event);
        };
        await session.decode({events: [encryptionState]}, async () => {});
        assert.equal(
            ghostEvents,
            1,
            'Restored joined rooms must route state to the actual ghost crypto',
        );
        ghostJoined = false;
        await session.decode(
            {events: [{...membership, state_key: ghostId, content: {membership: 'leave'}}]},
            async () => {},
        );
        assert.equal(ghostEvents, 2);
        await session.decode({events: [encryptionState]}, async () => {});
        assert.equal(ghostEvents, 2, 'Departed ghost must no longer receive room state');
        ghostJoined = true;
        const identity = session.bot.underlyingClient.crypto.clientDeviceEd25519;
        assert.equal(logins, 1);
        assert.equal(
            session.getIntent(ghostUserId(profile, 'TEST1234', domain, 'sh-threema')).userId,
            ghostUserId(profile, 'TEST1234', domain, 'sh-threema'),
        );
        // Namespace ownership is checked before creating even a cached framework intent.
        const ghost = ghostUserId(profile, 'TEST5678', domain, 'sh-threema');
        assert.equal(registration.isUserMatch(ghost, false), true);
        assert.throws(() => session!.getIntent(ghost), /not exclusively registered/);
        assert.throws(
            () => session!.getIntent(ghostUserId(profile, 'MISSING1', domain, 'sh-threema')),
            /not exclusively registered/,
        );
        assert.equal(logins, 1);
        assert.throws(
            () => session!.getIntent('@owner:example.invalid'),
            /outside the active profile/,
        );
        assert.throws(
            () => session!.getIntent(ghostUserId('OTHER123', 'TEST1234', domain, 'sh-threema')),
            /outside the active profile/,
        );
        await assert.rejects(
            session.decode(
                {
                    events: [
                        {
                            type: 'm.room.encrypted',
                            room_id: '!foreign:example.invalid',
                            event_id: '$foreign',
                            sender: '@owner:example.invalid',
                            content: {},
                        },
                    ],
                },
                async () => {},
            ),
            /outside the active profile/,
        );
        originalEnvelope = {
            event_id: '$original',
            room_id: '!owned:example.invalid',
            sender: botUserId,
            type: 'm.room.encrypted',
            origin_server_ts: 1,
            content: await crypto.encryptRoomEvent('!owned:example.invalid', 'm.room.message', {
                msgtype: 'm.text',
                body: 'session original',
            }),
        };
        let authorizations = 0;
        const originals = session.originalEvents({
            owner: botUserId,
            authorize: async () => {
                authorizations++;
            },
        });
        assert.equal(
            (await originals('$original', '!owned:example.invalid'))?.content.body,
            'session original',
        );
        assert.equal(authorizations, 2);
        const downloads = originalDownloads;
        for (const room of ['!foreign:example.invalid', managementId]) {
            await assert.rejects(originals('$original', room));
        }
        assert.equal(
            originalDownloads,
            downloads,
            'Foreign and management rooms cannot retrieve mutation originals',
        );
        let entered!: () => void;
        const authorizing = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const stalled = session.originalEvents({
            owner,
            authorize: async () => {
                entered();
                await new Promise<void>(() => {});
            },
        });
        const pending = assert.rejects(stalled('$original', '!owned:example.invalid'));
        await authorizing;
        await Promise.all([session.close(), session.close(), pending]);
        await assert.rejects(ownerClient.enableEncryption(), /unavailable/);
        assert.throws(() => ownerClient.underlyingClient, /closed/);
        await assert.rejects(session.ownerIntent(), /unavailable/);
        await assert.rejects(originals('$original', '!owned:example.invalid'));
        assert.throws(() => session!.originalEvents({owner, authorize: async () => {}}));
        assert.equal(
            originalDownloads,
            downloads,
            'Shutdown prevents a stalled authorization from downloading',
        );
        assert.equal(session.ready(), false);
        session = await open();
        const reopenedOwner = await session.ownerIntent();
        assert.equal(reopenedOwner.underlyingClient.crypto.clientDeviceId, ownerDevice);
        assert.equal(reopenedOwner.underlyingClient.crypto.clientDeviceEd25519, ownerKey);
        assert.equal(ownerLogins, 1);
        const reopenedGhost = session.getIntent(ghostId);
        const managementEncryption = {...encryptionState, room_id: managementId};
        assert.equal(
            await session.handleState(managementEncryption),
            false,
            'Restart must verify the management room again before routing state',
        );
        await session.registerManagementRoom(managementId, owner);
        assert.equal(await session.handleState(managementEncryption), true);
        await reopenedGhost.enableEncryption();
        assert.equal(reopenedGhost.underlyingClient.crypto.clientDeviceEd25519, ghostIdentity);
        assert.equal(ghostLogins, 1);
        let restoredEvents = 0;
        const restoredCrypto = reopenedGhost.underlyingClient.crypto;
        const restoredTracker = restoredCrypto.onRoomEvent.bind(restoredCrypto);
        restoredCrypto.onRoomEvent = async (room, event) => {
            restoredEvents++;
            await restoredTracker(room, event);
        };
        await session.decode({events: [encryptionState]}, async () => {});
        assert.equal(restoredEvents, 1);
        assert.equal(session.bot.underlyingClient.crypto.clientDeviceEd25519, identity);
        assert.equal(logins, 1);
        await session.close();
        session = undefined;
        offline = true;
        await assert.rejects(open(), /could not be verified/);
        assert.equal(logins, 1);
        offline = false;
        membershipFetchFailure = false;
        session = await open();
        assert.equal(session.bot.underlyingClient.crypto.clientDeviceEd25519, identity);
        assert.equal(logins, 1);
    } finally {
        await session?.close();
        setRequestFn(original);
        portals.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
