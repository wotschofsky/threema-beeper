import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkUpstream, parseUpstreamState, reviewUpstream, type UpstreamState} from '../src/operations/upstream-monitor.ts';
const empty = (): UpstreamState => ({schemaVersion: 1, snapshots: {}, pending: {}});
const page = (text = 'original') => `<html><body>${text.repeat(30)}</body></html>`;
const request = (terms = page(), status = 200): typeof fetch => async input =>
    String(input).includes('/tags?') ? new Response(JSON.stringify([{name: 'v2.0-beta65', commit: {sha: 'a'.repeat(40)}}]))
    : new Response(String(input).endsWith('/tos') ? terms : page(), {status});
await test('baseline and unchanged runs are quiet; changes remain pending across repeated checks and outages', async () => {
    const initial = await checkUpstream(empty(), request());
    assert.deepEqual(initial.changed, []);
    assert.deepEqual(initial.unavailable, []);
    const changed = await checkUpstream(initial.state, request(page('changed')));
    assert.deepEqual(changed.changed, ['terms']);
    const repeated = await checkUpstream(changed.state, request(page('changed')));
    assert.deepEqual(repeated.changed, []);
    assert.equal(repeated.state.pending.terms, 'changed');
    const failed = await checkUpstream(repeated.state, request('', 503));
    assert.deepEqual(failed.unavailable, ['changelog', 'terms']);
    assert.deepEqual(failed.state.snapshots, repeated.state.snapshots);
    assert.equal(failed.state.pending.terms, 'changed');
    const recovered = await checkUpstream(failed.state, request(page('changed')));
    assert.equal(recovered.state.pending.changelog, undefined);
    assert.equal(recovered.state.pending.terms, 'changed');
});
await test('invalid, oversized and redirected responses never replace the baseline', async () => {
    const baseline = await checkUpstream(empty(), request());
    for (const response of [() => new Response('invalid'), () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), () => new Response('', {status: 302})]) {
        const result = await checkUpstream(baseline.state, async (_input, init) => {
            assert.equal(init?.redirect, 'error'); assert(init?.signal);
            return response();
        });
        assert.equal(result.unavailable.length, 3);
        assert.deepEqual(result.state.snapshots, baseline.state.snapshots);
    }
    assert.throws(() => parseUpstreamState({schemaVersion: 1, snapshots: {terms: 'bad'}, pending: {}}));
});
await test('tag ordering and API metadata do not alert, but changed commit IDs do', async () => {
    const tagFetch = (reverse: boolean, sha = 'a'.repeat(40)): typeof fetch => async input => {
        if (!String(input).includes('/tags?')) return new Response(page());
        const tags = [{name: 'v2.0-beta65', commit: {sha}, zipball_url: 'ignored'}, {name: 'v2.0-beta64', commit: {sha: 'b'.repeat(40)}}];
        return new Response(JSON.stringify(reverse ? tags.reverse() : tags));
    };
    const initial = await checkUpstream(empty(), tagFetch(false));
    assert.deepEqual((await checkUpstream(initial.state, tagFetch(true))).changed, []);
    assert.deepEqual((await checkUpstream(initial.state, tagFetch(true, 'c'.repeat(40)))).changed, ['tags']);
});

await test('review keeps the baseline and later changes reopen review with a new revision', async () => {
    const baseline = await checkUpstream(empty(), request());
    const changed = await checkUpstream(baseline.state, request(page('changed')));
    const revision = changed.state.revisions!.terms!;
    const reviewed = reviewUpstream(changed.state, 'terms', revision);
    assert.equal(changed.state.pending.terms, 'changed');
    assert.deepEqual(reviewed.snapshots, changed.state.snapshots);
    assert.equal(reviewed.pending.terms, undefined);
    const unchanged = await checkUpstream(reviewed, request(page('changed')));
    assert.equal(unchanged.state.pending.terms, undefined);
    const later = await checkUpstream(unchanged.state, request(page('another')));
    assert.equal(later.state.pending.terms, 'changed');
    assert.equal(later.state.revisions!.terms, revision + 1);
    assert.throws(() => reviewUpstream(later.state, 'terms', revision), /stale/);
    for (const invalid of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => reviewUpstream(later.state, 'terms', invalid));
    assert.throws(() => reviewUpstream(later.state, 'unknown', revision));
});
