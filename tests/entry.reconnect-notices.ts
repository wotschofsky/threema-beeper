import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, stat, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ReconnectNotices} from '../src/operations/reconnect-notices.ts';
import {readReconnectState, writeReconnectState} from '../src/operations/reconnect-store.ts';
import {reconnectWindowMs, type ReconnectState} from '../src/operations/reconnect-policy.ts';
await test('outages persist before delivery, survive restart and retry the same notice after recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reconnect-state-'));
    let now = 0, ready = false, lose = true;
    const delivered = new Set<string>(), attempts: string[] = [];
    const bodies: unknown[] = [];
    const options = {
        owner: '@owner:example.invalid', now: () => now, ready: () => ready,
        persist: (s: ReconnectState) => writeReconnectState(directory, s),
        delivered: (id: string) => delivered.has(id), authorize: async () => '!management:example.invalid',
        send: async (id: string, _room: string, content: Record<string, unknown>) => {
            assert.equal((await readReconnectState(directory))?.revision, 1);
            attempts.push(id); bodies.push(content);
            if (lose) { lose = false; throw new Error('Lost response'); }
            delivered.add(id);
        },
    };
    try {
        const monitor = new ReconnectNotices(options);
        monitor.observe(false); await monitor.drain();
        now = reconnectWindowMs;
        assert.equal(await monitor.drain(), 0);
        const saved = await readReconnectState(directory);
        assert.equal(saved?.revision, 1); assert.equal(saved?.active, true);
        assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
        ready = true;
        await assert.rejects(monitor.drain(), /Lost response/);
        const restarted = new ReconnectNotices({...options, initial: saved});
        now += 2 * reconnectWindowMs;
        restarted.observe(true);
        assert.equal(await restarted.drain(), 1);
        assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(bodies[0], bodies[1]);
        assert.equal(await restarted.drain(), 0);
        await writeFile(join(directory, 'state.json'), 'corrupt');
        await assert.rejects(readReconnectState(directory));
    } finally { await rm(directory, {recursive: true, force: true}); }
});
await test('periodic observations avoid unnecessary writes and storage/authorization failures prevent sends', async () => {
    let now = 0, writes = 0, sends = 0, fail = false;
    const monitor = new ReconnectNotices({owner: '@owner:example.invalid', now: () => now,
        ready: () => true, delivered: () => false,
        persist: async () => { if (fail) throw new Error('Storage unavailable'); writes++; },
        authorize: async () => { throw new Error('Unauthorized'); }, send: async () => { sends++; }});
    monitor.observe(true); await monitor.drain();
    now = 100; await monitor.drain(); assert.equal(writes, 1);
    monitor.observe(false); await monitor.drain();
    now += reconnectWindowMs; fail = true;
    await assert.rejects(monitor.drain(), /Storage unavailable/);
    assert.equal(sends, 0);
    fail = false;
    await assert.rejects(monitor.drain(), /Unauthorized/); assert.equal(sends, 0);
});
await test('events arriving during persistence are saved on the next drain', async () => {
    let now = 0, release!: () => void;
    const saved: ReconnectState[] = [];
    const monitor = new ReconnectNotices({owner: '@owner:example.invalid', now: () => now,
        ready: () => false, delivered: () => false, authorize: async () => 'unused', send: async () => {},
        persist: async s => { saved.push(s); if (saved.length === 1) await new Promise<void>(r => {release = r;}); }});
    monitor.observe(true); const pending = monitor.drain();
    now = 1; monitor.observe(false); release(); await pending;
    await monitor.drain();
    assert.equal(saved.length, 2); assert.equal(saved[0]!.connected, true); assert.equal(saved[1]!.connected, false);
});
await test('restart does not count process downtime as a continuous offline interval', async () => {
    let now = 0, saved: ReconnectState | undefined;
    const options = {owner: '@owner:example.invalid', now: () => now, ready: () => false,
        delivered: () => false, authorize: async () => 'unused', send: async () => {},
        persist: async (s: ReconnectState) => {saved = s;}};
    const first = new ReconnectNotices(options); first.observe(false); await first.drain();
    now = 10 * reconnectWindowMs;
    const next = new ReconnectNotices({...options, initial: saved});
    next.observe(false); await next.drain(); assert.equal(saved?.revision, 0);
});
