import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeStatus} from '../src/service/bridge-status.ts';

await test('proxy status distinguishes the running bridge from its connected account', () => {
    const states = bridgeStatus(
        '@owner:example.invalid',
        'TEST1234',
        {live: true, ready: true, syncLive: true},
        1234567890000,
    );
    assert.deepEqual(
        states.map((s) => s.state_event),
        ['RUNNING', 'CONNECTED'],
    );
    assert.equal(states[0]!.timestamp, 1234567890);
    assert.equal(states[0]!.ttl, 90);
    assert.equal('remote_id' in states[0]!, false);
    assert.equal(states[1]!.remote_id, 'TEST1234');
    assert.equal(states[1]!.user_id, '@owner:example.invalid');
    for (const state of [
        {live: false, ready: true, syncLive: true},
        {live: true, ready: false, syncLive: true},
        {live: true, ready: true, syncLive: false},
    ])
        assert.equal(
            bridgeStatus('@owner:example.invalid', 'TEST1234', state)[1]!.state_event,
            'TRANSIENT_DISCONNECT',
        );
});
