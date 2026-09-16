import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {StateEventWorker} from '../src/matrix/state-event-worker.ts';
await test('state consumer advances past unrelated events and acknowledges only completed effects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-state-consumer-'));
    const key = randomBytes(32),
        filename = join(directory, 'inbox');
    let inbox = new TransactionInbox(filename, key);
    try {
        const event = {
            event_id: '$message',
            room_id: '!room:invalid',
            sender: '@owner:invalid',
            type: 'm.room.message',
            content: {body: 'private'},
        };
        inbox.accept('txn', {});
        inbox.complete('txn', [
            event,
            {...event, event_id: '$unknown', state_key: '', type: 'unknown'},
            {...event, event_id: '$retry', state_key: '', type: 'm.room.encryption'},
            {...event, event_id: '$ok', state_key: '', type: 'm.room.encryption'},
        ]);
        let fail = true;
        const worker = new StateEventWorker(inbox, async (value) => {
            if (value.type !== 'm.room.encryption') return false;
            if (value.event_id === '$retry' && fail) throw new Error('fixture failure');
            return true;
        });
        assert.equal(await worker.drain(2), 0);
        await assert.rejects(worker.drain(2), /remain pending/);
        assert.deepEqual(
            inbox.pendingEvents().map((value) => value.event_id),
            ['$message', '$unknown', '$retry'],
        );
        inbox.close();
        inbox = new TransactionInbox(filename, key);
        fail = false;
        const recovered = new StateEventWorker(
            inbox,
            async (value) => value.type === 'm.room.encryption',
        );
        assert.equal(await recovered.drain(2), 0);
        assert.equal(await recovered.drain(2), 1);
        assert.deepEqual(
            inbox.pendingEvents().map((value) => value.event_id),
            ['$message', '$unknown'],
        );
    } finally {
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
