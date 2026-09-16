import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UpstreamNotices} from '../src/operations/upstream-notices.ts';
import type {UpstreamState} from '../src/operations/upstream-monitor.ts';
await test('notices open no room when quiet and recover a lost send response with the same ID', async () => {
    let state: UpstreamState = {schemaVersion: 1, snapshots: {}, pending: {}};
    let authorizations = 0, ready = true, loseResponse = true;
    const requests: string[] = [];
    const remote = new Set<string>(), acknowledged = new Set<string>();
    const options = {
        owner: '@owner:example.invalid', ready: () => ready,
        load: async () => state, delivered: (id: string) => acknowledged.has(id),
        authorize: async () => { authorizations++; return '!management:example.invalid'; },
        send: async (id: string, room: string, content: Record<string, unknown>) => {
            assert.equal(room, '!management:example.invalid'); assert.equal(content.msgtype, 'm.notice');
            requests.push(id); remote.add(id);
            if (loseResponse) { loseResponse = false; throw new Error('Lost response'); }
            acknowledged.add(id);
        },
    };
    assert.equal(await new UpstreamNotices(options).drain(), 0);
    assert.equal(authorizations, 0);
    state = {schemaVersion: 1, snapshots: {terms: 'a'.repeat(64)}, pending: {terms: 'changed'}, revisions: {terms: 1}};
    await assert.rejects(new UpstreamNotices(options).drain(), /Lost response/u);
    assert.equal(await new UpstreamNotices(options).drain(), 1);
    assert.equal(requests[0], requests[1]); assert.equal(remote.size, 1);
    assert.equal(await new UpstreamNotices(options).drain(), 0);
    state.revisions!.terms = 2;
    ready = false;
    assert.equal(await new UpstreamNotices(options).drain(), 0);
    ready = true;
    assert.equal(await new UpstreamNotices(options).drain(), 1);
    assert.equal(remote.size, 2);
});
await test('authorization failure or readiness loss prevents notification', async () => {
    let ready = true, calls = 0;
    const options = {
        owner: '@owner:example.invalid', ready: () => ready,
        load: async (): Promise<UpstreamState> => ({schemaVersion: 1, snapshots: {}, pending: {terms: 'unavailable'}}),
        delivered: () => false,
        authorize: async (): Promise<string> => { throw new Error('Unauthorized room'); },
        send: async () => { calls++; },
    };
    await assert.rejects(new UpstreamNotices(options).drain(), /Unauthorized/u);
    const lost = new UpstreamNotices({...options, authorize: async () => { ready = false; return '!room:example.invalid'; }});
    assert.equal(await lost.drain(), 0); assert.equal(calls, 0);
});
