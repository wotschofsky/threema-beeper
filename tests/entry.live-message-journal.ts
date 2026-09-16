import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';

interface ModelStore {
    set(value: unknown): void;
}
interface SetStore {
    add(value: ModelStore): void;
    delete(value: ModelStore): void;
    clear(): void;
}
const backend = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {
    ProbeWritableStore: new (value: unknown) => ModelStore;
    ProbeSetStore: new (value: Set<ModelStore>) => SetStore;
    watchNodeMessages(
        handle: unknown,
        chatId: string,
        consume: (value: NormalizedNodeMessage) => Promise<void>,
        reset: () => void,
    ): Promise<() => Promise<void>>;
};
function model(text: string, reaction = false) {
    return {
        type: 'text',
        ctx: 1,
        controller: {},
        view: {
            id: 1n,
            ordinal: 1,
            direction: 1,
            createdAt: new Date(0),
            text,
            reactions: reaction
                ? [{senderIdentity: 'TEST5678', reaction: '👍', reactionAt: new Date(1)}]
                : [],
        },
    };
}
function fixture() {
    const message = new backend.ProbeWritableStore(model('initial'));
    const collection = new backend.ProbeSetStore(new Set([message]));
    const handle = {
        model: {
            user: {identity: 'SELF1234'},
            conversations: {
                getAll: async () => ({
                    get: () =>
                        new Set([
                            {
                                get: () => ({
                                    controller: {
                                        receiver: async () => ({
                                            get: () => ({type: 0, view: {identity: 'TEST5678'}}),
                                        }),
                                        getAllMessages: async () => collection,
                                    },
                                }),
                            },
                        ]),
                }),
            },
        },
    };
    return {message, collection, handle};
}
await test(
    'live upstream model updates normalize and commit to the encrypted journal in order',
    {timeout: 10000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-live-journal-'));
        const key = randomBytes(32);
        const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
        const f = fixture();
        let complete!: () => void;
        const observed = new Promise<void>((resolve) => {
            complete = resolve;
        });
        let count = 0;
        let resets = 0;
        const stop = await backend.watchNodeMessages(
            f.handle,
            'c:TEST5678',
            async (value) => {
                journal.upsert(value);
                if (++count === 2) complete();
            },
            () => {
                resets++;
            },
        );
        try {
            assert.equal(
                journal.pending().length,
                0,
                'Initial models are enumerated separately by history',
            );
            f.message.set(model('edited'));
            f.message.set(model('edited', true));
            await observed;
            const changes = journal.pending();
            assert.equal(changes.length, 2);
            assert.deepEqual(changes[0]!.message.content, {type: 'text', text: 'edited'});
            assert.equal(changes[0]!.message.reactions.length, 0);
            assert.equal(changes[1]!.message.reactions.length, 1);
            f.collection.delete(f.message);
            assert.equal(resets, 1);
            f.message.set(model('detached'));
            await stop();
            assert.equal(count, 2);
        } finally {
            await stop();
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
await test(
    'live consumer failure invalidates the stream instead of silently dropping an edit',
    {timeout: 5000},
    async () => {
        const f = fixture();
        let signal!: () => void;
        const reset = new Promise<void>((resolve) => {
            signal = resolve;
        });
        let count = 0;
        const stop = await backend.watchNodeMessages(
            f.handle,
            'c:TEST5678',
            async () => {
                count++;
                throw new Error('synthetic storage failure');
            },
            signal,
        );
        try {
            f.message.set(model('failed edit'));
            await reset;
            f.message.set(model('must reconcile'));
            await stop();
            assert.equal(count, 1);
        } finally {
            await stop();
        }
    },
);

await test(
    'new models emit their initial value and queue overflow invalidates the stream',
    {timeout: 5000},
    async () => {
        const f = fixture();
        let first!: () => void;
        const added = new Promise<void>((resolve) => {
            first = resolve;
        });
        let resets = 0;
        let consumed = 0;
        const stop = await backend.watchNodeMessages(
            f.handle,
            'c:TEST5678',
            async () => {
                consumed++;
                first();
            },
            () => {
                resets++;
            },
        );
        try {
            f.collection.add(new backend.ProbeWritableStore(model('newly added')));
            await added;
            for (let index = 0; index < 2050; index++) f.message.set(model(`burst ${index}`));
            assert.equal(resets, 1);
            await stop();
            assert.equal(consumed, 1, 'Overflowed stream must discard pending work and reconcile');
        } finally {
            await stop();
        }
    },
);
