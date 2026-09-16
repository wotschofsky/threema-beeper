import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MessageJournal} from '../src/threema/message-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('snapshot pages roll back wholly on an invalid row and publish after reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-snapshot-page-'));
    const key = randomBytes(32);
    const filename = join(directory, 'journal.sqlite');
    let journal = new MessageJournal(filename, key, 'SELF1234');
    const message: NormalizedNodeMessage = {
        chatId: 'c:TEST1234', messageId: 'm:0000000000000001',
        direction: 'inbound', senderIdentity: 'TEST1234', ordinal: 1n,
        createdAt: new Date(1000), reactions: [], content: {type: 'text', text: 'Synthetic page'},
    };
    try {
        const token = journal.beginReconciliation(message.chatId);
        assert.throws(() => journal.stageSnapshotPage(token, [message, {...message, chatId: 'c:OTHER123'}]));
        assert.throws(() => journal.stageSnapshotPage(token, Array(501).fill(message)));
        journal.commitReconciliation(token);
        assert.equal(journal.pendingCount(), 0, 'An invalid page must not leave its first row staged');
        const next = journal.beginReconciliation(message.chatId);
        journal.stageSnapshotPage(next, [message]);
        assert.equal(journal.pendingCount(), 0, 'Unpublished snapshots must not become deliverable');
        journal.close();
        journal = new MessageJournal(filename, key, 'SELF1234');
        journal.commitReconciliation(next);
        assert.deepEqual(journal.pending().map(row => row.message), [message]);
    } finally {
        journal.close(); key.fill(0); rmSync(directory, {recursive: true, force: true});
    }
});
