import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
const profile = 'SELF1234';
await test('recovery retry never resets uncertain sends, including an unallocated outcome across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-')),
        key = randomBytes(32),
        file = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(file, key),
        sends = 0;
    const request = (event: string, chatId: string) => ({
        requestId: createRequestId(),
        profile,
        transactionId: event,
        eventId: '$' + event,
        roomId: '!' + event + ':invalid',
        sender: '@owner:invalid',
        chatId,
        text: 'synthetic',
    });
    try {
        const ambiguous = request('ambiguous', 'c:ECHOECHO'),
            pending = request('pending', 'c:TEST1234');
        store.prepare(ambiguous);
        store.prepare(pending);
        store.claim(ambiguous.requestId);
        store.unknown(ambiguous.requestId);
        store.deferPreflight(pending.requestId, Date.now() + 300000);
        store.close();
        store = new OutboxStore(file, key);
        store.recoverInterrupted();
        assert.equal(store.retryPrepared(profile), 1);
        assert.equal(store.get(ambiguous.requestId)?.state, 'OUTCOME_UNKNOWN');
        const worker = new OutboxWorker(
            store,
            {
                send: async (_request, persist) => {
                    sends++;
                    await persist(['m:0100000000000000']);
                    return ['m:0100000000000000'];
                },
            },
            () => true,
        );
        await worker.flushOne();
        await worker.flushOne();
        assert.equal(sends, 1);
        assert.equal(store.get(ambiguous.requestId)?.state, 'OUTCOME_UNKNOWN');
        assert.ok(!JSON.stringify(store.recoveryItems(profile)).includes('synthetic'));
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
await test('100 disconnect/restart/lost-response cycles recover from observed IDs without duplicate sends', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-soak-')),
        key = randomBytes(32),
        file = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(file, key),
        sends = 0;
    try {
        for (let cycle = 1; cycle <= 100; cycle++) {
            const request = {
                requestId: createRequestId(),
                profile,
                transactionId: String(cycle),
                eventId: '$test' + cycle,
                roomId: '!test:invalid',
                sender: '@owner:invalid',
                chatId: 'c:ECHOECHO',
                text: 'synthetic',
            };
            store.prepare(request);
            const id = 'm:' + cycle.toString(16).padStart(16, '0');
            let online = false;
            const worker = new OutboxWorker(
                store,
                {
                    send: async (_r, persist) => {
                        sends++;
                        await persist([id]);
                        throw Error('lost response');
                    },
                },
                () => online,
            );
            assert.equal(await worker.flushOne(), false);
            online = true;
            await assert.rejects(worker.flushOne());
            store.close();
            store = new OutboxStore(file, key);
            store.recoverInterrupted();
            store.retryPrepared(profile);
            assert.equal(store.nextPrepared(), undefined);
            store.observe(profile, 'c:ECHOECHO', id);
            assert.equal(store.get(request.requestId)?.state, 'ACKED');
        }
        assert.equal(sends, 100);
        assert.deepEqual(store.pendingCounts(profile), {
            prepared: 0,
            dispatching: 0,
            awaitingEcho: 0,
            uncertain: 0,
        });
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
