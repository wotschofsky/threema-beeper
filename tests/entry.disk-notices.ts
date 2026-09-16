import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskNotices, diskCapacity, parseDiskState, readDiskState, writeDiskState, type DiskState} from '../src/operations/disk-notices.ts';

await test('disk warning persists offline, survives restart and retries identical content after recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disk-notices-'));
    let now = 0, available = 20n, ready = false, loseResponse = true;
    const delivered = new Set<string>(), attempts: {id: string; content: Record<string, unknown>}[] = [];
    const options = {owner: '@owner:example.invalid', now: () => now, ready: () => ready,
        sample: async () => ({blocks: 100n, available}),
        persist: (state: DiskState) => writeDiskState(directory, state), delivered: (id: string) => delivered.has(id),
        authorize: async () => '!management:example.invalid',
        send: async (id: string, _room: string, content: Record<string, unknown>) => {
            assert.equal((await readDiskState(directory))?.revision, 1);
            attempts.push({id, content});
            if (loseResponse) { loseResponse = false; throw new Error('Lost response'); }
            delivered.add(id);
        }};
    try {
        assert.equal(await readDiskState(directory), undefined);
        const monitor = new DiskNotices(options);
        assert.equal(await monitor.drain(), 0);
        assert.deepEqual(await readDiskState(directory), {schemaVersion: 1, revision: 1, active: true});
        assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
        ready = true;
        await assert.rejects(monitor.drain(), /Lost response/);
        now = 60_000; available = 90n;
        const restarted = new DiskNotices({...options, initial: await readDiskState(directory)});
        assert.equal(await restarted.drain(), 1);
        assert.deepEqual(attempts[0], attempts[1]);
        assert.equal((await readDiskState(directory))?.active, false);
        assert.equal(await restarted.drain(), 0);
        const actual = await diskCapacity(directory);
        assert(actual.blocks > 0n && actual.available >= 0n && actual.available <= actual.blocks);
        await writeFile(join(directory, 'state.json'), 'bad'); await assert.rejects(readDiskState(directory));
        await writeFile(join(directory, 'state.json'), ' '.repeat(1025)); await assert.rejects(readDiskState(directory), /too large/);
    } finally { await rm(directory, {recursive: true, force: true}); }
});

await test('sampling is bounded and hysteresis only rearms after more than 25% available', async () => {
    let now = 100_000, available = 21n, samples = 0, writes = 0;
    let saved: DiskState | undefined;
    const monitor = new DiskNotices({owner: 'owner', now: () => now, ready: () => false,
        sample: async () => { samples++; return {blocks: 100n, available}; },
        persist: async state => { saved = {...state}; writes++; }, delivered: () => false,
        authorize: async () => { throw new Error('Must not authorize offline'); }, send: async () => { throw new Error('Must not send offline'); }});
    await monitor.drain(); await monitor.drain(); assert.equal(samples, 1); assert.equal(writes, 0);
    available = 20n; now += 60_000; await monitor.drain(); assert.equal(saved?.revision, 1);
    available = 25n; now += 60_000; await monitor.drain(); assert.equal(saved?.active, true); assert.equal(writes, 1);
    available = 26n; now += 60_000; await monitor.drain(); assert.equal(saved?.active, false);
    available = 0n; now += 60_000; await monitor.drain(); assert.equal(saved?.revision, 2);
    now = 0; await monitor.drain(); assert.equal(samples, 6); assert.equal(writes, 3);
});

await test('failed persistence, invalid samples and unauthorized rooms cannot emit a warning', async () => {
    let fail = true, sends = 0, saved: DiskState | undefined;
    const options = {owner: 'owner', now: () => 0, ready: () => true,
        sample: async () => ({blocks: 100n, available: 0n}),
        persist: async (state: DiskState) => { if (fail) throw new Error('Storage full'); saved = state; },
        delivered: () => false, authorize: async () => { throw new Error('Unauthorized room'); },
        send: async () => { sends++; }};
    const monitor = new DiskNotices(options);
    await assert.rejects(monitor.drain(), /Storage full/); assert.equal(saved, undefined);
    fail = false; await assert.rejects(monitor.drain(), /Unauthorized room/);
    assert.equal(parseDiskState(saved).revision, 1); assert.equal(sends, 0);
    await assert.rejects(new DiskNotices({...options, sample: async () => ({blocks: 0n, available: 0n})}).drain(), /capacity/);
    await assert.rejects(new DiskNotices({...options, sample: async () => ({blocks: 100n, available: -1n})}).drain(), /capacity/);
    assert.throws(() => parseDiskState({schemaVersion: 1, revision: 0, active: true}));
    assert.throws(() => parseDiskState({schemaVersion: 1, revision: 1, active: true, extra: 'unexpected'}));
});
