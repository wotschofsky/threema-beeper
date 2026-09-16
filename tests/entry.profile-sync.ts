import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ProfileSynchronizer} from '../src/threema/profile-sync.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

const chats = ['c:TEST1234', 'c:TEST5678'].map((chatId) => ({
    chatId,
    name: chatId,
    unreadCount: 0,
    archived: false,
    pinned: false,
}));
function message(chatId: string, text: string): NormalizedNodeMessage {
    return {
        chatId,
        messageId: 'm:0100000000000000',
        direction: 'outbound',
        senderIdentity: 'SELF1234',
        createdAt: new Date(0),
        ordinal: 1n,
        reactions: [],
        content: {type: 'text', text},
    };
}
await test(
    'failed history keeps delivery gated and stop interrupts retry backoff',
    {timeout: 5000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-sync-failure-'));
        const key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
        let retry!: () => void;
        const retrying = new Promise<void>((resolve) => {
            retry = resolve;
        });
        let attempts = 0;
        let closed = 0;
        const sync: ProfileSynchronizer = new ProfileSynchronizer(
            {
                directory: async () => ({contacts: [], groups: []}),
                watchTopology: async () => async () => {
                    closed++;
                },
                conversations: async () => chats.slice(0, 1),
                watchMessages: async () => async () => {
                    closed++;
                },
                history: async () => {
                    attempts++;
                    throw new Error('synthetic read failure');
                },
            },
            journal,
            {
                retryMs: 60000,
                onState: (state) => {
                    if (state === 'retrying') retry();
                },
            },
        );
        try {
            sync.start();
            await retrying;
            assert.equal(sync.readyForMessages, false);
            assert.equal(journal.pending().length, 0);
            await sync.stop();
            assert.equal(attempts, 1);
            assert.equal(closed, 2);
            const token = journal.beginReconciliation(chats[0]!.chatId);
            journal.abortReconciliation(token);
        } finally {
            await sync.stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
await test(
    'profile attaches every watcher before history, gates readiness and retries topology changes',
    {timeout: 10000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-profile-sync-'));
        const key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
        const callbacks = new Map<string, (message: NormalizedNodeMessage) => Promise<void>>();
        let reset!: () => void;
        let topologyAttached = false;
        let topologyStops = 0;
        let chatStops = 0;
        let liveCount = 0;
        let first!: () => void;
        let second!: () => void;
        const firstLive = new Promise<void>((resolve) => {
            first = resolve;
        });
        const secondLive = new Promise<void>((resolve) => {
            second = resolve;
        });
        const sync: ProfileSynchronizer = new ProfileSynchronizer(
            {
                directory: async () => ({contacts: [], groups: []}),
                watchTopology: async (callback) => {
                    reset = callback;
                    topologyAttached = true;
                    return async () => {
                        topologyStops++;
                        topologyAttached = false;
                    };
                },
                conversations: async () => {
                    assert.ok(topologyAttached);
                    return chats;
                },
                watchMessages: async (chatId, consume) => {
                    callbacks.set(chatId, consume);
                    return async () => {
                        chatStops++;
                        callbacks.delete(chatId);
                    };
                },
                history: async (chatId) => {
                    assert.equal(
                        callbacks.size,
                        2,
                        'Attach both message watchers before any history',
                    );
                    assert.equal(sync.readyForMessages, false);
                    if (chatId === chats[0]!.chatId)
                        await callbacks.get(chats[1]!.chatId)!(
                            message(chats[1]!.chatId, 'live edit'),
                        );
                    return {messages: [message(chatId, 'snapshot')]};
                },
            },
            journal,
            {
                retryMs: 1,
                periodicMs: 60000,
                onState: (state) => {
                    if (state === 'live') {
                        if (++liveCount === 1) first();
                        else second();
                    }
                },
            },
        );
        try {
            sync.start();
            await firstLive;
            assert.ok(sync.readyForMessages);
            assert.deepEqual(
                journal.pending().map((change) => change.message.content),
                [
                    {type: 'text', text: 'snapshot'},
                    {type: 'text', text: 'snapshot'},
                    {type: 'text', text: 'live edit'},
                ],
            );
            reset();
            assert.equal(sync.readyForMessages, false);
            await secondLive;
            assert.ok(sync.readyForMessages);
            assert.equal(topologyStops, 1);
            assert.equal(chatStops, 2);
            await sync.stop();
            assert.equal(sync.state, 'stopped');
            assert.equal(sync.readyForMessages, false);
            assert.equal(topologyStops, 2);
            assert.equal(chatStops, 4);
        } finally {
            await sync.stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'profile-wide buffer overflow discards the epoch and a fresh snapshot recovers',
    {timeout: 5000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-sync-overflow-'));
        const key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
        const callbacks = new Map<string, (message: NormalizedNodeMessage) => Promise<void>>();
        let epoch = 0;
        let closed = 0;
        let recovered!: () => void;
        const live = new Promise<void>((resolve) => {
            recovered = resolve;
        });
        const sync: ProfileSynchronizer = new ProfileSynchronizer(
            {
                directory: async () => ({contacts: [], groups: []}),
                conversations: async () => chats,
                watchTopology: async () => {
                    epoch++;
                    return async () => {
                        closed++;
                    };
                },
                watchMessages: async (chatId, consume) => {
                    callbacks.set(chatId, consume);
                    return async () => {
                        closed++;
                        callbacks.delete(chatId);
                    };
                },
                history: async (chatId) => {
                    if (epoch === 1) {
                        await callbacks.get(chats[0]!.chatId)!(
                            message(chats[0]!.chatId, 'discarded one'),
                        );
                        await callbacks.get(chats[1]!.chatId)!(
                            message(chats[1]!.chatId, 'discarded two'),
                        );
                        await assert.rejects(
                            callbacks.get(chats[1]!.chatId)!(message(chats[1]!.chatId, 'overflow')),
                            /event buffer overflow/,
                        );
                        assert.equal(sync.readyForMessages, false);
                        // Even a source that catches the callback error cannot commit this epoch.
                    } else {
                        assert.equal(journal.pending().length, 0);
                        assert.equal(journal.metadata(), undefined);
                        if (chatId === chats[0]!.chatId) {
                            await callbacks.get(chats[0]!.chatId)!(
                                message(chats[0]!.chatId, 'recovered one'),
                            );
                            await callbacks.get(chats[1]!.chatId)!(
                                message(chats[1]!.chatId, 'recovered two'),
                            );
                        }
                    }
                    return {messages: [message(chatId, 'snapshot')]};
                },
            },
            journal,
            {
                maxBufferedEvents: 2,
                retryMs: 1,
                periodicMs: 60000,
                onState: (state) => {
                    if (state === 'live') recovered();
                },
            },
        );
        try {
            for (const maxBufferedEvents of [0, -1, 1.5, NaN, Infinity, 100001]) {
                assert.throws(
                    () => new ProfileSynchronizer({} as never, journal, {maxBufferedEvents}),
                    /buffer limit/,
                );
            }
            sync.start();
            await live;
            assert.equal(epoch, 2);
            assert.equal(closed, 3);
            assert.ok(sync.readyForMessages);
            assert.deepEqual(
                journal.pending().map((change) => change.message.content),
                [
                    {type: 'text', text: 'snapshot'},
                    {type: 'text', text: 'snapshot'},
                    {type: 'text', text: 'recovered one'},
                    {type: 'text', text: 'recovered two'},
                ],
            );
            // The staging cap does not cap ordinary live delivery after reconciliation.
            for (let i = 0; i < 4; i++) {
                await callbacks.get(chats[0]!.chatId)!(message(chats[0]!.chatId, `live ${i}`));
            }
            assert.ok(sync.readyForMessages);
        } finally {
            await sync.stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'explicit resync interrupts backoff and coalesces live requests without restarting the profile',
    {timeout: 5000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-explicit-resync-'));
        const key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
        let attempts = 0,
            stops = 0,
            lives = 0;
        let retry!: () => void, first!: () => void, second!: () => void;
        const retrying = new Promise<void>((resolve) => {
            retry = resolve;
        });
        const firstLive = new Promise<void>((resolve) => {
            first = resolve;
        });
        const secondLive = new Promise<void>((resolve) => {
            second = resolve;
        });
        const sync = new ProfileSynchronizer(
            {
                watchTopology: async () => async () => {
                    stops++;
                },
                conversations: async () => {
                    if (++attempts === 1) throw new Error('fixture failure');
                    return [];
                },
                directory: async () => ({contacts: [], groups: []}),
                watchMessages: async () => {
                    throw new Error('No chats');
                },
                history: async () => {
                    throw new Error('No chats');
                },
            },
            journal,
            {
                retryMs: 60000,
                periodicMs: 60000,
                onState: (state) => {
                    if (state === 'retrying') retry();
                    if (state === 'live') {
                        if (++lives === 1) first();
                        else second();
                    }
                },
            },
        );
        try {
            assert.equal(sync.resync(), false);
            sync.start();
            await retrying;
            assert.equal(sync.resync(), true);
            assert.equal(sync.resync(), true);
            await firstLive;
            const epoch = journal.metadata()!.epoch;
            assert.equal(attempts, 2);
            assert.equal(sync.resync(), true);
            assert.equal(sync.readyForMessages, false);
            assert.equal(sync.resync(), true);
            await secondLive;
            assert.equal(attempts, 3);
            assert.equal(stops, 2);
            assert.notEqual(journal.metadata()!.epoch, epoch);
            assert.equal(sync.readyForMessages, true);
            await sync.stop();
            assert.equal(sync.resync(), false);
            assert.equal(stops, 3);
        } finally {
            await sync.stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'contact-only reconciliation never watches or reads group history',
    {timeout: 5000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-contact-sync-'));
        const key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
        let live!: () => void;
        const ready = new Promise<void>((resolve) => {
            live = resolve;
        });
        const watched: string[] = [],
            read: string[] = [];
        const sync = new ProfileSynchronizer(
            {
                directory: async () => ({contacts: [], groups: []}),
                watchTopology: async () => async () => {},
                conversations: async () => [
                    chats[0]!,
                    {...chats[0]!, chatId: 'g:SELF1234:0100000000000000'},
                ],
                watchMessages: async (chat) => {
                    watched.push(chat);
                    return async () => {};
                },
                history: async (chat) => {
                    read.push(chat);
                    return {messages: []};
                },
            },
            journal,
            {
                contactOnly: true,
                onState: (state) => {
                    if (state === 'live') live();
                },
            },
        );
        try {
            sync.start();
            await ready;
            assert.deepEqual(watched, ['c:TEST1234']);
            assert.deepEqual(read, watched);
            assert.deepEqual(
                journal.metadata()?.chats.map((chat) => chat.chatId),
                watched,
            );
        } finally {
            await sync.stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'confirmation recovery runs after commit and its failure keeps readiness gated',
    {timeout: 5000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'confirmation-gate-')),
            key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal'), key, 'SELF1234');
        let consume!: (value: NormalizedNodeMessage) => Promise<void>;
        let retry!: () => void,
            live!: () => void,
            attempts = 0;
        const retrying = new Promise<void>((resolve) => {
            retry = resolve;
        });
        const ready = new Promise<void>((resolve) => {
            live = resolve;
        });
        const sync: ProfileSynchronizer = new ProfileSynchronizer(
            {
                directory: async () => ({contacts: [], groups: []}),
                conversations: async () => chats.slice(0, 1),
                watchTopology: async () => async () => {},
                watchMessages: async (_chat, callback) => {
                    consume = callback;
                    return async () => {};
                },
                history: async () => ({messages: [message(chats[0]!.chatId, 'snapshot')]}),
            },
            journal,
            {
                retryMs: 60000,
                onState: (state) => {
                    if (state === 'retrying') retry();
                    if (state === 'live') live();
                },
                onReconciled: async (signal) => {
                    signal.throwIfAborted();
                    assert.equal(sync.readyForMessages, false);
                    assert.ok(journal.metadata());
                    assert.equal(
                        journal.message(chats[0]!.chatId, 'm:0100000000000000')?.content.type,
                        'text',
                    );
                    // Live events arriving during recovery must not target an already committed staging token.
                    await consume(message(chats[0]!.chatId, 'during recovery'));
                    if (++attempts === 1) throw Error('synthetic recovery failure');
                },
            },
        );
        try {
            sync.start();
            await retrying;
            assert.equal(sync.readyForMessages, false);
            assert.equal(sync.resync(), true);
            await ready;
            assert.equal(attempts, 2);
            assert.equal(sync.readyForMessages, true);
            assert.deepEqual(journal.message(chats[0]!.chatId, 'm:0100000000000000')?.content, {
                type: 'text',
                text: 'during recovery',
            });
        } finally {
            await sync.stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
