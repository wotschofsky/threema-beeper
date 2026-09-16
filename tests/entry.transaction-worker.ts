import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {TransactionWorker} from '../src/matrix/transaction-worker.ts';

await test('worker retains failed transactions and serializes concurrent drains', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-worker-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const event = {
        event_id: '$synthetic',
        room_id: '!room:example.invalid',
        sender: '@synthetic:example.invalid',
        type: 'm.room.message',
        content: {body: 'synthetic'},
    };
    let fail = true;
    let calls = 0;
    const worker = new TransactionWorker(inbox, async (_body, emit) => {
        calls++;
        await emit(event);
        if (fail) throw new Error('synthetic missing key');
    });
    try {
        inbox.accept('first', {events: []});
        await assert.rejects(worker.drain(), /transactions remain pending/);
        assert.equal(inbox.next()?.attempts, 1);
        assert.equal(inbox.pendingEvents().length, 0);
        fail = false;
        const first = worker.drain();
        const second = worker.drain();
        assert.equal(first, second);
        assert.equal(await first, 1);
        assert.equal(calls, 2);
        assert.equal(inbox.next(), undefined);
        assert.deepEqual(inbox.pendingEvents(), [event]);
        assert.equal(await worker.drain(), 0);
    } finally {
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('a missing key does not prevent a later transaction from supplying it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-worker-order-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    let hasKey = false;
    const worker = new TransactionWorker(inbox, async (body) => {
        if ((body as {kind: string}).kind === 'key') hasKey = true;
        else if (!hasKey) throw new Error('synthetic missing key');
    });
    try {
        inbox.accept('message', {kind: 'message'});
        inbox.accept('key', {kind: 'key'});
        await assert.rejects(worker.drain(), /transactions remain pending/);
        assert.ok(hasKey);
        assert.equal(await worker.drain(), 1);
        assert.equal(inbox.next(), undefined);
    } finally {
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
