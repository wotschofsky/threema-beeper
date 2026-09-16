import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {JournalDelivery} from '../src/matrix/journal-delivery.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
const chat = {chatId: 'c:TEST1234', name: 'Test', unreadCount: 0, archived: false, pinned: false};
const message: NormalizedNodeMessage = {
    chatId: chat.chatId,
    messageId: 'm:0100000000000000',
    direction: 'outbound',
    senderIdentity: 'SELF1234',
    createdAt: new Date(0),
    ordinal: 1n,
    reactions: [],
    content: {type: 'text', text: 'A'},
};
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'threema-delivery-'));
    const key = randomBytes(32);
    const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
    const token = journal.beginReconciliation(chat.chatId);
    journal.stage(token, 'snapshot', message);
    journal.commitProfile([token], {directory: {contacts: [], groups: []}, chats: [chat]});
    return {
        journal,
        cleanup: () => {
            journal.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        },
    };
}
await test('delivery gates on reconciliation, applies metadata first and preserves failed work with stable retry IDs', async () => {
    const f = fixture();
    let ready = false;
    let failMetadata = true;
    let failMessage = true;
    const calls: string[] = [];
    const ids: string[] = [];
    const delivery = new JournalDelivery(
        f.journal,
        {
            metadata: async () => {
                calls.push('metadata');
                if (failMetadata) throw new Error('synthetic metadata failure');
            },
            message: async (_, id) => {
                calls.push('message');
                ids.push(id);
                if (failMessage) throw new Error('synthetic message failure');
            },
        },
        () => ready,
    );
    try {
        assert.equal(await delivery.flush(), 0);
        assert.deepEqual(calls, []);
        ready = true;
        await assert.rejects(delivery.flush());
        assert.ok(f.journal.metadata(true));
        assert.equal(f.journal.pending().length, 1);
        failMetadata = false;
        await assert.rejects(delivery.flush());
        assert.equal(f.journal.metadata(true), undefined);
        assert.equal(f.journal.pending().length, 1);
        failMessage = false;
        assert.deepEqual(await Promise.all([delivery.flush(), delivery.flush()]), [1, 1]);
        assert.deepEqual(calls, ['metadata', 'metadata', 'message', 'message']);
        assert.equal(ids[0], ids[1]);
        assert.equal(f.journal.pending().length, 0);
        f.journal.upsert({...message, content: {type: 'text', text: 'B'}});
        f.journal.upsert(message);
        await delivery.flush();
        assert.notEqual(ids[2], ids[3]);
        assert.notEqual(ids[0], ids[3]);
    } finally {
        await delivery.stop();
        f.cleanup();
    }
});
await test('readiness changes during a delivery prevent the next queued operation', async () => {
    const f = fixture();
    f.journal.upsert({...message, messageId: 'm:0200000000000000', ordinal: 2n});
    let ready = true;
    let count = 0;
    const delivery = new JournalDelivery(
        f.journal,
        {
            metadata: async () => undefined,
            message: async () => {
                count++;
                ready = false;
            },
        },
        () => ready,
    );
    try {
        assert.equal(await delivery.flush(), 1);
        assert.equal(count, 1);
        assert.equal(f.journal.pending().length, 1);
    } finally {
        await delivery.stop();
        f.cleanup();
    }
});
