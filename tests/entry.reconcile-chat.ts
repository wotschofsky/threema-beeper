import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {reconcileChat} from '../src/threema/reconcile-chat.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

const base: NormalizedNodeMessage = {
    chatId: 'c:TEST1234',
    messageId: 'm:0100000000000000',
    direction: 'outbound',
    senderIdentity: 'SELF1234',
    ordinal: 1n,
    createdAt: new Date(0),
    reactions: [],
    content: {type: 'text', text: 'snapshot'},
};
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'threema-reconcile-'));
    const key = randomBytes(32);
    const filename = join(directory, 'journal.sqlite');
    const journal = new MessageJournal(filename, key, 'SELF1234');
    return {
        journal,
        filename,
        key,
        cleanup: () => {
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        },
    };
}
await test('subscribe-first reconciliation stages live edits and publishes them after stale snapshot records', async () => {
    const f = fixture();
    let consume!: (message: NormalizedNodeMessage) => Promise<void>;
    let stopped = 0;
    try {
        const stop = await reconcileChat(
            {
                watchMessages: async (_, callback) => {
                    consume = callback;
                    return async () => {
                        stopped++;
                    };
                },
                history: async () => {
                    assert.ok(consume, 'Subscribe before enumerating');
                    await consume({...base, content: {type: 'text', text: 'live edit'}});
                    assert.equal(
                        f.journal.pending().length,
                        0,
                        'Incomplete reconciliation must not be delivered',
                    );
                    return {messages: [base]};
                },
            },
            f.journal,
            base.chatId,
            {onReset: () => assert.fail('Unexpected reset')},
        );
        assert.deepEqual(
            f.journal.pending().map((item) => item.message.content),
            [
                {type: 'text', text: 'snapshot'},
                {type: 'text', text: 'live edit'},
            ],
        );
        await consume({...base, content: {type: 'text', text: 'after snapshot'}});
        assert.equal(f.journal.pending().length, 3);
        await stop();
        await stop();
        assert.equal(stopped, 1);
    } finally {
        f.cleanup();
    }
});
await test('reset during history aborts staged data without publishing a partial snapshot', async () => {
    const f = fixture();
    let invalidate!: () => void;
    let resets = 0;
    try {
        await assert.rejects(
            reconcileChat(
                {
                    watchMessages: async (_, consume, reset) => {
                        invalidate = reset;
                        await consume(base);
                        return async () => undefined;
                    },
                    history: async () => {
                        invalidate();
                        return {messages: [base]};
                    },
                },
                f.journal,
                base.chatId,
                {
                    onReset: () => {
                        resets++;
                    },
                },
            ),
        );
        assert.equal(resets, 1);
        assert.equal(f.journal.pending().length, 0);
        const replacement = f.journal.beginReconciliation(base.chatId);
        f.journal.abortReconciliation(replacement);
    } finally {
        f.cleanup();
    }
});
await test('incomplete staged records survive reopen but stay hidden until explicitly discarded', () => {
    const f = fixture();
    try {
        const epoch = f.journal.beginReconciliation(base.chatId);
        f.journal.stage(epoch, 'live', base);
        const reopened = new MessageJournal(f.filename, f.key, 'SELF1234');
        try {
            assert.equal(reopened.pending().length, 0);
            assert.throws(() => reopened.beginReconciliation(base.chatId));
            reopened.discardIncompleteReconciliations();
            const fresh = reopened.beginReconciliation(base.chatId);
            reopened.stage(fresh, 'snapshot', base);
            reopened.commitReconciliation(fresh);
            assert.equal(reopened.pending().length, 1);
        } finally {
            reopened.close();
        }
    } finally {
        f.cleanup();
    }
});
