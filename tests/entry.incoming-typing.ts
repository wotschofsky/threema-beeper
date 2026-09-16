import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IncomingTyping} from '../src/matrix/incoming-typing.ts';

await test('incoming typing refreshes, stops, drops disconnected state, and releases subscriptions', async () => {
    let now = 0,
        ready = true,
        stops = 0;
    let changed!: (typing: boolean) => void;
    const sent: boolean[] = [];
    const runtime = new IncomingTyping({
        chats: () => ['c:ABCD1234', 'g:SELF1234:0100000000000000'],
        now: () => now,
        ready: () => ready,
        watch: async (chat, callback) => {
            assert.equal(chat, 'c:ABCD1234');
            changed = callback;
            callback(false);
            return async () => {
                stops++;
            };
        },
        send: async (_chat, typing, current) => {
            if (!current()) return false;
            sent.push(typing);
            return true;
        },
    });
    await runtime.drain();
    assert.deepEqual(sent, []);
    changed(true);
    await runtime.drain();
    now = 4999;
    await runtime.drain();
    now = 5000;
    await runtime.drain();
    changed(false);
    await runtime.drain();
    assert.deepEqual(sent, [true, true, false]);
    changed(true);
    runtime.clear();
    await runtime.drain();
    assert.deepEqual(sent, [true, true, false]);
    ready = false;
    changed(true);
    ready = true;
    await runtime.drain();
    assert.deepEqual(sent, [true, true, false]);
    await runtime.stop();
    changed(true);
    await runtime.drain();
    assert.equal(stops, 1);
    assert.equal(sent.length, 3);
});

await test('authorization-delayed typing cannot send after a disconnect invalidates it', async () => {
    let changed!: (typing: boolean) => void;
    let release!: () => void;
    const sent: boolean[] = [];
    const runtime = new IncomingTyping({
        chats: () => ['c:ABCD1234'],
        ready: () => true,
        watch: async (_chat, callback) => {
            changed = callback;
            return async () => {};
        },
        send: async (_chat, typing, current) => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            if (!current()) return false;
            sent.push(typing);
            return true;
        },
    });
    await runtime.drain();
    changed(true);
    const pending = runtime.drain();
    runtime.clear();
    release();
    await pending;
    assert.deepEqual(sent, []);
    await runtime.stop();
});
