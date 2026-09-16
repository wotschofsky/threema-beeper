import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProfileRuntime, type ProfileRuntimeOptions} from '../src/service/profile-runtime.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import type {BridgeIntent} from '../src/matrix/journal-sink.ts';
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'threema-runtime-'));
    const key = randomBytes(32),
        profile = 'SELF1234';
    const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, profile);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const intent = (userId: string): BridgeIntent => {
        const client = new MatrixClient('https://matrix.invalid', 'synthetic');
        client.getUserProfile = async () => ({displayname: profile});
        return {
            userId,
            underlyingClient: client,
            ensureRegistered: async () => {},
            enableEncryption: async () => {},
            joinRoom: async (room) => room,
            leaveRoom: async () => {},
        };
    };
    const options: ProfileRuntimeOptions = {
        profile,
        owner: '@owner:invalid',
        domain: 'invalid',
        journal,
        inbox,
        portals,
        outbox,
        bot: intent('@bot:invalid'),
        getIntent: intent,
        matrixReady: () => true,
        intervalMs: 10,
        decode: async () => {},
        backend: {
            watchConnection: async (changed) => {
                changed(true);
                return async () => {};
            },
            identity: async () => profile,
            stop: async () => {},
            directory: async () => ({contacts: [], groups: []}),
            conversations: async () => [],
            watchTopology: async () => async () => {},
            watchMessages: async () => async () => {},
            history: async () => ({messages: []}),
            sendText: async () => {
                throw new Error('Unexpected send');
            },
        },
    };
    return {
        options,
        async close() {
            journal.close();
            inbox.close();
            portals.close();
            outbox.close();
            key.fill(0);
            await rm(directory, {recursive: true, force: true});
        },
    };
}
await test(
    'profile runtime gates readiness through reconciliation and metadata, then shuts down every loop',
    {timeout: 5000},
    async (context) => {
        const {options, close} = await fixture();
        let release!: () => void,
            stops = 0,
            unsubscribes = 0,
            cryptoReady = true;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        options.backend.directory = async () => {
            await hold;
            return {contacts: [], groups: []};
        };
        options.backend.stop = async () => {
            stops++;
            release();
        };
        options.backend.watchTopology = async () => async () => {
            unsubscribes++;
        };
        options.matrixReady = () => cryptoReady;
        options.backend.reactMessage = async () => {
            assert.fail('No reaction was queued');
        };
        options.backend.reactionState = async () => {
            assert.fail('No recovery was queued');
        };
        let managementDrains = 0;
        options.management = () => ({
            drain: async () => {
                managementDrains++;
                return 0;
            },
        });
        options.inbox.accept('synthetic-decode', {});
        const runtime = new ProfileRuntime(options);
        try {
            await Promise.all([runtime.start(), runtime.start()]);
            assert.equal(runtime.status.ready, false);
            assert.equal(runtime.status.synchronization, 'syncing');
            release();
            while (!runtime.status.ready || options.inbox.next())
                await delay(5, undefined, {signal: context.signal});
            assert.equal(runtime.status.synchronization, 'live');
            assert.ok(options.journal.metadata());
            assert.equal(options.journal.metadata(true), undefined);
            cryptoReady = false;
            assert.equal(runtime.status.ready, false);
            await Promise.all([runtime.stop(), runtime.stop()]);
            assert.equal(stops, 1);
            assert.equal(unsubscribes, 1);
            assert.ok(managementDrains > 0);
            const finalDrains = managementDrains;
            await delay(25);
            assert.equal(managementDrains, finalDrains);
            assert.deepEqual(runtime.status, {
                state: 'stopped',
                ready: false,
                synchronization: 'stopped',
                inbound: 'stopped',
                outbound: 'stopped',
                transactions: 'stopped',
                stateEvents: 'stopped',
                management: 'stopped',
                reactions: 'stopped',
                receipts: 'disabled',
                files: 'disabled',
                mutations: 'disabled',
                typing: 'disabled',
            });
            await assert.rejects(runtime.start(), /cannot restart/);
        } finally {
            release();
            await runtime.stop();
            await close();
        }
    },
);
await test(
    'wrong profile and cancelled startup terminate the backend without starting loops',
    {timeout: 5000},
    async () => {
        for (const mode of ['wrong-identity', 'cancel']) {
            const {options, close} = await fixture();
            let stops = 0,
                enumerations = 0,
                resolve!: (identity: string) => void;
            options.backend.identity =
                mode === 'cancel'
                    ? () =>
                          new Promise<string>((done) => {
                              resolve = done;
                          })
                    : async () => 'OTHER123';
            options.backend.stop = async () => {
                stops++;
                resolve?.('SELF1234');
            };
            options.backend.directory = async () => {
                enumerations++;
                return {contacts: [], groups: []};
            };
            const runtime = new ProfileRuntime(options);
            try {
                const started = runtime.start();
                const rejected = assert.rejects(
                    started,
                    mode === 'cancel' ? /cancelled/ : /identity mismatch/,
                );
                if (mode === 'cancel') await runtime.stop();
                await rejected;
                assert.equal(stops, 1);
                assert.equal(enumerations, 0);
                assert.equal(runtime.status.state, 'stopped');
            } finally {
                await runtime.stop();
                await close();
            }
        }
    },
);

await test('file and video runtime share cancellation and require native video support', async () => {
    const {options, close} = await fixture();
    let signal: AbortSignal | undefined, videoSignal: AbortSignal | undefined;
    options.renderMedia = async () => ({});
    options.backend.sendPreparedFile = async () => {
        throw new Error('Unexpected file send');
    };
    options.files = {
        maximumBytes: 1024,
        createVideoPreparation: (value) => {
            videoSignal = value;
            return async () => {
                throw new Error('Unexpected video preparation');
            };
        },
        createPreparation: (value) => {
            signal = value;
            return async () => {
                throw new Error('Unexpected file preparation');
            };
        },
    };
    assert.throws(() => new ProfileRuntime(options), /Video preparation requires/);
    options.backend.sendPreparedVideo = async () => {
        throw new Error('Unexpected video send');
    };
    const runtime = new ProfileRuntime(options);
    try {
        assert.equal(videoSignal, signal);
        assert.equal(runtime.status.files, 'stopped');
        await runtime.start();
        assert.equal(signal!.aborted, false);
        await runtime.stop();
        assert.equal(signal!.aborted, true);
        assert.equal(runtime.status.files, 'stopped');
    } finally {
        await runtime.stop();
        await close();
    }
});

await test('mutation runtime requires native support and cancels its original loader on stop', async () => {
    const {options, close} = await fixture();
    let signal: AbortSignal | undefined;
    options.mutations = {
        createOriginalLoader: (value) => {
            signal = value;
            return async () => {
                throw new Error('Unexpected original retrieval');
            };
        },
    };
    try {
        assert.throws(() => new ProfileRuntime(options), /requires native mutation support/);
        assert.equal(signal, undefined);
        options.backend.mutationState = async () => false;
        options.backend.mutateMessage = async () => {
            throw new Error('Unexpected mutation');
        };
        const runtime = new ProfileRuntime(options);
        try {
            assert.equal(runtime.status.mutations, 'stopped');
            await runtime.start();
            assert.equal(signal!.aborted, false);
            await runtime.stop();
            assert.equal(signal!.aborted, true);
            assert.equal(runtime.status.mutations, 'stopped');
        } finally {
            await runtime.stop();
        }
    } finally {
        await close();
    }
});

await test('service mutation options authorize original reads against fresh owned portal state', async () => {
    const {mutationOptions} = await import('../src/service/mutation-options.ts');
    const {options, close} = await fixture();
    let captured!: Parameters<
        import('../src/service/matrix-session.ts').MatrixSession['originalEvents']
    >[0];
    let joined = true,
        reads = 0;
    const room = '!owned:invalid',
        chat = 'c:ABCD1234';
    try {
        options.portals.bind(options.profile, chat, room);
        options.portals.bind('ELSE1234', chat, '!foreign:invalid');
        options.bot.underlyingClient.getRoomState = async () => {
            reads++;
            return [
                {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {algorithm: 'm.megolm.v1.aes-sha2'},
                },
                {
                    type: 'm.bridge',
                    state_key: 'threema://bridge',
                    content: {
                        creator: options.owner,
                        network: {id: options.profile},
                        channel: {id: chat},
                    },
                },
                {
                    type: 'm.room.member',
                    state_key: options.owner,
                    content: {membership: joined ? 'join' : 'leave'},
                },
            ].map((event, index) => ({
                event_id: `$state${index}`,
                room_id: room,
                origin_server_ts: 0,
                unsigned: {},
                sender: options.bot.userId,
                ...event,
            }));
        };
        const loader = async () => undefined;
        const wiring = mutationOptions({
            profile: options.profile,
            owner: options.owner,
            portals: options.portals,
            matrix: {
                bot: options.bot,
                originalEvents: (input) => {
                    captured = input;
                    return loader;
                },
            },
        });
        const shutdown = new AbortController();
        assert.equal(wiring.createOriginalLoader(shutdown.signal), loader);
        assert.equal(captured.owner, options.owner);
        assert.equal(captured.signal, shutdown.signal);
        await captured.authorize(room);
        joined = false;
        await assert.rejects(captured.authorize(room), /authorization failed/);
        assert.equal(reads, 2, 'Membership is fetched for every authorization');
        await assert.rejects(captured.authorize('!foreign:invalid'), /outside the active profile/);
        await assert.rejects(captured.authorize('!unknown:invalid'), /outside the active profile/);
        assert.equal(reads, 2, 'Unowned rooms never reach Matrix retrieval');
        shutdown.abort();
        assert.equal(captured.signal!.aborted, true);
    } finally {
        await close();
    }
});

await test(
    'profile scheduler delivers fresh typing and drops input while unready',
    {timeout: 5000},
    async (context) => {
        const {options, close} = await fixture();
        const room = '!typing:invalid',
            chat = 'c:PEER1234';
        const sent: boolean[] = [];
        const incoming: boolean[] = [];
        let incomingChanged: ((typing: boolean) => void) | undefined;
        let incomingStops = 0;
        options.backend.watchTyping = async (requestedChat, changed) => {
            assert.equal(requestedChat, chat);
            incomingChanged = changed;
            return async () => {
                incomingStops++;
            };
        };
        const ghost = '@ghost:invalid';
        options.portals.bindGhost(options.profile, chat.slice(2), ghost);
        const getIntent = options.getIntent;
        options.getIntent = (userId) => {
            const intent = getIntent(userId);
            if (userId !== ghost) return intent;
            intent.underlyingClient.setTyping = async (requestedRoom, typing, timeout) => {
                assert.equal(requestedRoom, room);
                assert.equal(timeout, 10000);
                incoming.push(typing);
            };
            return intent;
        };
        let ready = true;
        let connectionChanged!: (connected: boolean) => void;
        options.backend.watchConnection = async (changed) => {
            connectionChanged = changed;
            changed(true);
            return async () => {
                changed(false);
            };
        };
        options.matrixReady = () => ready;
        options.backend.setTyping = async (request) => {
            assert.equal(request.profile, options.profile);
            assert.equal(request.chatId, chat);
            sent.push(request.typing);
        };
        options.portals.bind(options.profile, chat, room);
        options.bot.underlyingClient.getRoomState = async () =>
            [
                {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {algorithm: 'm.megolm.v1.aes-sha2'},
                },
                {
                    type: 'm.bridge',
                    state_key: 'threema://bridge',
                    sender: options.bot.userId,
                    content: {
                        creator: options.owner,
                        network: {id: options.profile},
                        channel: {id: chat},
                    },
                },
                {type: 'm.room.member', state_key: options.owner, content: {membership: 'join'}},
            ].map((event, index) => ({
                event_id: `$typing-state${index}`,
                room_id: room,
                origin_server_ts: 0,
                unsigned: {},
                sender: options.bot.userId,
                ...event,
            }));
        const runtime = new ProfileRuntime(options);
        const update = (users: unknown) =>
            runtime.receiveEphemeral({
                'de.sorunome.msc2409.ephemeral': [
                    {type: 'm.typing', room_id: room, content: {user_ids: users}},
                ],
            });
        try {
            update([options.owner]);
            await runtime.start();
            while (!runtime.status.ready) await delay(5, undefined, {signal: context.signal});
            const metadata = options.journal.metadata.bind(options.journal);
            options.journal.metadata = (pendingOnly = false) => {
                const value = metadata(pendingOnly);
                return value
                    ? {
                          ...value,
                          chats: [
                              {
                                  chatId: chat,
                                  name: 'Synthetic',
                                  unreadCount: 0,
                                  archived: false,
                                  pinned: false,
                              },
                          ],
                      }
                    : value;
            };
            while (!incomingChanged) await delay(5, undefined, {signal: context.signal});
            incomingChanged(true);
            while (incoming.length < 1) await delay(5, undefined, {signal: context.signal});
            incomingChanged(false);
            while (incoming.length < 2) await delay(5, undefined, {signal: context.signal});
            assert.deepEqual(incoming, [true, false]);
            assert.deepEqual(sent, []);
            update([options.owner]);
            while (sent.length < 1) await delay(5, undefined, {signal: context.signal});
            update([]);
            while (sent.length < 2) await delay(5, undefined, {signal: context.signal});
            assert.deepEqual(sent, [true, false]);
            update([options.owner]);
            connectionChanged(false);
            connectionChanged(true);
            await delay(30);
            assert.deepEqual(sent, [true, false], 'brief reconnect clears queued typing');
            connectionChanged(false);
            update([options.owner]);
            connectionChanged(true);
            await delay(30);
            assert.deepEqual(sent, [true, false], 'offline input is discarded');
            ready = false;
            update([options.owner]);
            ready = true;
            await delay(30);
            assert.deepEqual(sent, [true, false]);
            await runtime.stop();
            assert.equal(runtime.status.typing, 'stopped');
            assert.equal(incomingStops, 1);
            update([options.owner]);
            assert.deepEqual(sent, [true, false]);
        } finally {
            await runtime.stop();
            await close();
        }
    },
);

await test('reduced runtime leaves all deferred feature loops disabled', async () => {
    const {options, close} = await fixture();
    options.textOnly = true;
    const unexpected = async () => {
        throw new Error('Deferred feature invoked');
    };
    options.backend.setTyping = unexpected;
    options.backend.watchTyping = unexpected;
    options.backend.reactMessage = unexpected;
    options.backend.reactionState = unexpected;
    options.backend.mutateMessage = unexpected;
    options.backend.mutationState = unexpected;
    options.mutations = {
        createOriginalLoader: () => {
            throw new Error('Deferred loader initialized');
        },
    };
    options.files = {
        maximumBytes: 1024,
        createPreparation: () => {
            throw new Error('Deferred media initialized');
        },
    };
    const runtime = new ProfileRuntime(options);
    try {
        assert.equal(runtime.status.files, 'disabled');
        assert.equal(runtime.status.mutations, 'disabled');
        assert.equal(runtime.status.reactions, 'disabled');
        assert.equal(runtime.status.typing, 'disabled');
        await runtime.start();
        runtime.receiveEphemeral({
            'de.sorunome.msc2409.ephemeral': [
                {type: 'm.typing', room_id: '!room:invalid', content: {user_ids: [options.owner]}},
            ],
        });
    } finally {
        await runtime.stop();
        await close();
    }
});

await test('personal media and group opt-ins leave unrelated feature loops disabled', async () => {
    const {options, close} = await fixture();
    options.textOnly = true;
    options.includeGroups = true;
    options.includeMedia = true;
    const group = 'g:SELF1234:0100000000000000';
    const watched: string[] = [],
        read: string[] = [];
    options.backend.directory = async () => ({
        contacts: [],
        groups: [
            {
                groupKey: group,
                creatorIdentity: options.profile,
                groupId: 1n,
                name: 'Private fixture',
                memberIdentities: [options.profile],
                userState: 0,
            },
        ],
    });
    options.backend.conversations = async () => [
        {chatId: group, name: 'Private fixture', unreadCount: 0, archived: false, pinned: false},
    ];
    options.backend.watchMessages = async (chat) => {
        watched.push(chat);
        return async () => {};
    };
    options.backend.history = async (chat) => {
        read.push(chat);
        return {messages: []};
    };
    const unexpected = async () => {
        throw new Error('Unrequested feature invoked');
    };
    options.backend.setTyping = unexpected;
    options.backend.watchTyping = unexpected;
    options.backend.reactMessage = unexpected;
    options.backend.reactionState = unexpected;
    options.backend.mutateMessage = unexpected;
    options.backend.mutationState = unexpected;
    options.backend.sendPreparedFile = unexpected;
    options.renderMedia = unexpected;
    let prepared = false;
    options.files = {
        maximumBytes: 1024,
        createPreparation: () => {
            prepared = true;
            return unexpected;
        },
    };
    options.mutations = {
        createOriginalLoader: () => {
            throw new Error('Mutation loader enabled');
        },
    };
    const runtime = new ProfileRuntime(options);
    try {
        assert.equal(prepared, true);
        assert.notEqual(runtime.status.files, 'disabled');
        assert.equal(runtime.status.typing, 'disabled');
        assert.equal(runtime.status.reactions, 'disabled');
        assert.equal(runtime.status.mutations, 'disabled');
        await runtime.start();
        for (let attempt = 0; attempt < 100 && read.length === 0; attempt++) await delay(10);
        assert.deepEqual(watched, [group]);
        assert.deepEqual(read, [group]);
        assert.equal(options.journal.metadata()?.chats[0]?.chatId, group);
    } finally {
        await runtime.stop();
        await close();
    }
});

await test('connection monitoring works without typing and ignores intentional shutdown disconnects', async () => {
    const {options, close} = await fixture();
    const observations: boolean[] = [];
    let report!: (connected: boolean) => void, unsubscribed = 0;
    options.textOnly = true;
    options.connectionChanged = connected => observations.push(connected);
    options.backend.watchConnection = async changed => {
        report = changed; changed(true);
        return async () => { unsubscribed++; changed(false); };
    };
    const runtime = new ProfileRuntime(options);
    try {
        await runtime.start();
        assert.equal(runtime.status.typing, 'disabled');
        report(false); report(true);
        assert.deepEqual(observations, [true, false, true]);
        await runtime.stop();
        assert.equal(unsubscribed, 1);
        assert.deepEqual(observations, [true, false, true]);
    } finally { await runtime.stop(); await close(); }
});

await test('startup reconciles retained confirmations without replaying unchanged Matrix messages', {timeout: 10000}, async (context) => {
    for (const evidence of ['confirmed', 'local-only', 'other-sender', 'inbound'] as const) {
        const {options, close} = await fixture();
        const request = {
            requestId: '01900000-0000-7000-8000-000000000001',
            profile: options.profile, transactionId: 'retained', eventId: '$retained',
            roomId: '!retained:invalid', sender: options.owner, chatId: 'c:TEST1234', text: 'fixture',
        };
        const id = 'm:0100000000000000';
        const message: import('../src/threema/history.ts').NormalizedNodeMessage = {
            chatId: request.chatId, messageId: id, direction: evidence === 'inbound' ? 'inbound' : 'outbound',
            senderIdentity: evidence === 'other-sender' || evidence === 'inbound' ? 'TEST1234' : options.profile,
            createdAt: new Date(0), ordinal: 1n, reactions: [], content: {type: 'text', text: 'fixture'},
            ...(evidence === 'local-only' ? {} : {sentAt: new Date(1000)}),
        };
        const runtime = new ProfileRuntime(options);
        try {
            options.outbox.prepare(request);
            options.outbox.claim(request.requestId);
            options.outbox.recordIds(request.requestId, [id]);
            options.outbox.sent(request.requestId, [id]);
            options.journal.upsert(message);
            for (const row of options.journal.pending()) options.journal.acknowledge(row.sequence);
            assert.equal(options.journal.upsert(message), 'duplicate');
            await runtime.start();
            while (!runtime.status.ready) await delay(5, undefined, {signal: context.signal});
            assert.equal(options.outbox.get(request.requestId)?.state, evidence === 'confirmed' ? 'ACKED' : 'OUTCOME_UNKNOWN');
            assert.equal(options.journal.pending().length, 0, 'Confirmation recovery must not create Matrix replay work');
        } finally { await runtime.stop(); await close(); }
    }
});
