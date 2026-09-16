import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TypingRuntime} from '../src/outbox/typing-runtime.ts';
import type {NodeTypingRequest} from '../src/threema/typing-command.ts';

await test('typing coalesces refreshes, expires, and discards disconnected state', async () => {
    let now = 0,
        ready = true;
    const calls: NodeTypingRequest[] = [];
    const runtime = new TypingRuntime({
        profile: 'SELF1234',
        owner: '@owner:invalid',
        portals: {
            portalForRoom: (room) =>
                room === '!room:invalid' ? {profile: 'SELF1234', chat: 'c:TEST1234'} : undefined,
        },
        now: () => now,
        ready: () => ready,
        authorize: async () => {},
        setTyping: async (request) => {
            calls.push(request);
        },
    });
    for (let i = 0; i < 5; i++) runtime.update('!room:invalid', ['@owner:invalid']);
    assert.equal(await runtime.drain(), 1);
    assert.equal(await runtime.drain(), 0);
    now = 2000;
    assert.equal(await runtime.drain(), 1);
    now = 15000;
    assert.equal(await runtime.drain(), 1);
    assert.deepEqual(
        calls.map((value) => value.typing),
        [true, true, false],
    );
    runtime.update('!foreign:invalid', ['@owner:invalid']);
    assert.equal(await runtime.drain(), 0);
    runtime.update('!room:invalid', ['@owner:invalid']);
    ready = false;
    assert.equal(await runtime.drain(), 0);
    ready = true;
    assert.equal(await runtime.drain(), 0, 'Reconnect never replays old typing');
});

await test('typing changes during authorization supersede delayed starts', async () => {
    let release!: () => void;
    const calls: boolean[] = [];
    const runtime = new TypingRuntime({
        profile: 'SELF1234',
        owner: '@owner:invalid',
        portals: {portalForRoom: () => ({profile: 'SELF1234', chat: 'c:TEST1234'})},
        ready: () => true,
        authorize: () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
        setTyping: async (request) => {
            calls.push(request.typing);
        },
    });
    runtime.update('!room:invalid', ['@owner:invalid']);
    const start = runtime.drain();
    runtime.update('!room:invalid', []);
    release();
    await start;
    assert.deepEqual(calls, []);
    const stop = runtime.drain();
    release();
    await stop;
    assert.deepEqual(calls, [false]);
});

await test('failed typing is dropped instead of replaying when the backend recovers', async () => {
    let connected = false;
    const sent: boolean[] = [];
    const runtime = new TypingRuntime({
        profile: 'SELF1234',
        owner: '@owner:invalid',
        portals: {portalForRoom: () => ({profile: 'SELF1234', chat: 'c:TEST1234'})},
        ready: () => true,
        authorize: async () => {},
        setTyping: async (request) => {
            if (!connected) throw new Error('Synthetic connection loss');
            sent.push(request.typing);
        },
    });
    runtime.update('!room:invalid', ['@owner:invalid']);
    await assert.rejects(runtime.drain(), /could not be applied/);
    connected = true;
    assert.equal(await runtime.drain(), 0);
    assert.deepEqual(sent, []);
    runtime.update('!room:invalid', ['@owner:invalid']);
    assert.equal(await runtime.drain(), 1);
    assert.deepEqual(sent, [true]);
});
