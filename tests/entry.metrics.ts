import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderMetrics} from '../src/service/metrics.ts';
await test('metrics omit unknown proxy state and reject nonnumeric values without labels', () => {
    const snapshot = {
        live: true,
        ready: false,
        syncLive: false,
        uptimeSeconds: 1.5,
        residentBytes: 2048,
    };
    const text = renderMetrics({...snapshot, private: 'secret'} as typeof snapshot);
    assert.ok(!text.includes('bbctl_proxy_up'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('{'));
    assert.ok(text.includes('process_uptime_seconds 1.5\n'));
    for (const residentBytes of [NaN, Infinity, -1])
        assert.throws(() => renderMetrics({...snapshot, residentBytes}));
    assert.throws(() => renderMetrics({...snapshot, live: 'secret'} as never));
});

await test('reaction metrics expose fixed numeric counters without event or emoji labels', () => {
    const snapshot = {
        live: true,
        ready: true,
        syncLive: true,
        uptimeSeconds: 1,
        residentBytes: 1024,
        reactionQueues: {
            prepared: 2,
            dispatching: 1,
            uncertain: 3,
            failureNotices: 4,
            retirements: 5,
        },
    };
    const rendered = renderMetrics(snapshot);
    assert.match(rendered, /bridge_reaction_parts_uncertain 3\n/);
    assert.match(rendered, /bridge_reaction_failure_notices_pending 4\n/);
    assert.match(rendered, /bridge_reaction_redactions_pending 5\n/);
    assert(!rendered.includes('{'));
    for (const uncertain of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() =>
            renderMetrics({...snapshot, reactionQueues: {...snapshot.reactionQueues, uncertain}}),
        );
});
