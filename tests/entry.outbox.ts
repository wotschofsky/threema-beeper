import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {OutboxStore, type TextRequest} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';
const request: TextRequest = {
    requestId: '01900000-0000-7000-8000-000000000001',
    profile: 'SELF1234',
    transactionId: 'txn1',
    eventId: '$event1',
    roomId: '!room:invalid',
    sender: '@owner:invalid',
    chatId: 'c:TEST1234',
    text: 'private outbox text',
};
const ids = ['m:ffffffffffffffff', 'm:feffffffffffffff'];
await test('outbox persists deduplicated requests and never dispatches uncertain work after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-outbox-'));
    const filename = join(directory, 'outbox.sqlite'),
        key = randomBytes(32);
    let store = new OutboxStore(filename, key);
    try {
        store.prepare(request);
        assert.equal(
            store.prepare({
                ...request,
                requestId: request.requestId.replace(/1$/, '2'),
                transactionId: 'redelivery',
            }).request.requestId,
            request.requestId,
        );
        assert.throws(() => store.prepare({...request, text: 'changed'}), /conflict/);
        let ready = false,
            calls = 0;
        const worker = new OutboxWorker(
            store,
            {
                send: async (_request, allocated) => {
                    calls++;
                    await allocated(ids);
                    throw new Error('synthetic crash after first remote side effect');
                },
            },
            () => ready,
        );
        assert.equal(await worker.flushOne(), false);
        ready = true;
        await assert.rejects(worker.flushOne(), /synthetic crash/);
        assert.equal(store.get(request.requestId)!.state, 'OUTCOME_UNKNOWN');
        store.close();
        store = new OutboxStore(filename, key);
        store.recoverInterrupted();
        assert.deepEqual(store.get(request.requestId)!.ids, ids);
        assert.equal(store.claim(), undefined);
        assert.equal(calls, 1);
        assert.equal(store.observe('OTHER123', request.chatId, ids[0]!), undefined);
        assert.throws(
            () => store.observe(request.profile, 'c:WRONG123', ids[0]!),
            /conversation conflict/,
        );
        assert.equal(
            store.observe(request.profile, request.chatId, ids[0]!)!.state,
            'OUTCOME_UNKNOWN',
        );
        assert.equal(store.observe(request.profile, request.chatId, ids[1]!)!.state, 'ACKED');
        assert.equal(store.observe(request.profile, request.chatId, ids[1]!)!.state, 'ACKED');
        assert.ok(!(await readFile(filename)).includes(Buffer.from(request.text)));
        // Simulate a process dying after claim but before the allocation callback.
        const second = {
            ...request,
            requestId: request.requestId.replace(/1$/, '3'),
            eventId: '$event2',
        };
        store.prepare(second);
        store.claim();
        store.close();
        store = new OutboxStore(filename, key);
        store.recoverInterrupted();
        assert.equal(store.get(second.requestId)!.state, 'OUTCOME_UNKNOWN');
        assert.deepEqual(store.get(second.requestId)!.ids, []);
        assert.equal(store.claim(), undefined);
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
await test('outbox handles echo before send completion and serializes overlapping dispatch requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-outbox-echo-'));
    const key = randomBytes(32),
        store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    try {
        store.prepare(request);
        let calls = 0;
        const worker = new OutboxWorker(
            store,
            {
                send: async (_request, allocated) => {
                    calls++;
                    await allocated(ids);
                    assert.throws(
                        () => store.recordIds(request.requestId, [...ids].reverse()),
                        /allocation conflict/,
                    );
                    store.observe(request.profile, request.chatId, ids[0]!);
                    store.observe(request.profile, request.chatId, ids[1]!);
                    return ids;
                },
            },
            () => true,
        );
        assert.deepEqual(await Promise.all([worker.flushOne(), worker.flushOne()]), [true, true]);
        assert.equal(calls, 1);
        assert.equal(store.get(request.requestId)!.state, 'ACKED');
        assert.equal(await worker.flushOne(), false);
        const second = {
            ...request,
            requestId: request.requestId.replace(/1$/, '2'),
            eventId: '$event2',
        };
        store.prepare(second);
        const invalid = new OutboxWorker(store, {send: async () => ids}, () => true);
        await assert.rejects(invalid.flushOne(), /result conflict/);
        assert.equal(store.get(second.requestId)!.state, 'OUTCOME_UNKNOWN');
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
