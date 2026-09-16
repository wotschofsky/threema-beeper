import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {test} from 'node:test';
import {
    acceptSendAllocation,
    SendAllocation,
    parseTextSend,
} from '../src/threema/send-allocation.ts';
const ids = ['m:ffffffffffffffff', 'm:feffffffffffffff'];
await test('worker allocation waits for durable acknowledgement and validates the returned IDs', async () => {
    const {port1, port2} = new MessageChannel();
    let release!: () => void;
    const durable = new Promise<void>((resolve) => {
        release = resolve;
    });
    let saving = false,
        proceeded = false;
    const parent = acceptSendAllocation(port1, async (received) => {
        assert.deepEqual(received, ids);
        saving = true;
        (received as string[]).reverse();
        await durable;
    });
    const worker = new SendAllocation(port2, 1000);
    try {
        const task = worker.record(ids).then(() => {
            proceeded = true;
        });
        while (!saving) await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(proceeded, false);
        assert.throws(() => parent.result(ids), /committed allocation/);
        release();
        await task;
        assert.equal(proceeded, true);
        assert.deepEqual(parent.result(ids), ids);
        assert.throws(() => parent.result([...ids].reverse()), /committed allocation/);
        await assert.rejects(worker.record(ids), /SEND_ALLOCATION_FAILED/);
    } finally {
        worker.close();
        parent.close();
    }
});
await test('failed persistence, lost channel, timeout and malformed acknowledgement never release a send', async () => {
    for (const failure of ['persistence', 'disconnect', 'timeout', 'malformed']) {
        const {port1, port2} = new MessageChannel();
        const worker = new SendAllocation(port2, 30);
        const parent =
            failure === 'persistence'
                ? acceptSendAllocation(port1, async () => {
                      throw new Error('sensitive store failure must not cross the channel');
                  })
                : undefined;
        if (failure === 'disconnect') port1.on('message', () => port1.close());
        if (failure === 'malformed')
            port1.on('message', () => port1.postMessage({type: 'unexpected'}));
        try {
            await assert.rejects(worker.record(ids), /^Error: SEND_ALLOCATION_FAILED$/);
        } finally {
            parent?.close();
            worker.close();
            port1.close();
        }
    }
});
await test('text send payload projection excludes Matrix data and rejects malformed input', () => {
    assert.deepEqual(
        parseTextSend({
            profile: 'SELF1234',
            chatId: 'c:TEST1234',
            text: 'fixture',
            token: 'private',
        }),
        {profile: 'SELF1234', chatId: 'c:TEST1234', text: 'fixture'},
    );
    for (const value of [null, {}, {profile: 'SELF1234', chatId: 'c:TEST1234', text: ''}])
        assert.throws(() => parseTextSend(value), /Invalid text send/);
});
