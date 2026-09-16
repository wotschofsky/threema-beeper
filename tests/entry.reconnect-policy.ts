import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observeReconnect, parseReconnectState, reconnectWindowMs as windowMs} from '../src/operations/reconnect-policy.ts';
await test('distinct rapid losses alert once; repeated disconnected observations do not inflate the count', () => {
    let state = observeReconnect(undefined, false, 0);
    for (let now = 1; now < 100; now++) state = observeReconnect(state, false, now);
    assert.equal(state.revision, 0); assert.deepEqual(state.disconnects, []);
    for (let i = 0; i < 3; i++) {
        state = observeReconnect(state, true, 100 + i * 2);
        state = observeReconnect(state, false, 101 + i * 2);
    }
    assert.equal(state.revision, 1); assert.equal(state.active, true);
    for (let i = 0; i < 100; i++) state = observeReconnect(state, i % 2 === 0, 200 + i);
    assert.equal(state.revision, 1); assert(state.disconnects.length <= 3);
});
await test('prolonged startup outage alerts, and sustained recovery re-arms later incidents', () => {
    let state = observeReconnect(undefined, false, 0);
    state = observeReconnect(state, false, windowMs - 1); assert.equal(state.revision, 0);
    state = observeReconnect(state, false, windowMs); assert.equal(state.revision, 1);
    state = observeReconnect(state, true, windowMs + 1);
    state = observeReconnect(state, true, 2 * windowMs + 1); assert.equal(state.active, false);
    state = observeReconnect(state, false, 2 * windowMs + 2);
    state = observeReconnect(state, false, 3 * windowMs + 2); assert.equal(state.revision, 2);
});
await test('widely spaced losses stay quiet and persisted state preserves incident identity', () => {
    let state = observeReconnect(undefined, true, 0);
    for (let i = 0; i < 5; i++) {
        state = observeReconnect(JSON.parse(JSON.stringify(state)), false, i * 2 * windowMs + 1);
        state = observeReconnect(state, true, i * 2 * windowMs + 2);
    }
    assert.equal(state.revision, 0);
    state = observeReconnect(state, false, 10 * windowMs);
    state = observeReconnect(state, false, 11 * windowMs);
    assert.equal(state.revision, 1);
    const restarted = observeReconnect(JSON.parse(JSON.stringify(state)), false, 11 * windowMs + 1);
    assert.equal(restarted.revision, 1);
});
await test('clock rollback does not create an outage or duplicate an active incident; invalid input is rejected', () => {
    let state = observeReconnect(undefined, false, 1000);
    state = observeReconnect(state, false, 1000 + windowMs); assert.equal(state.revision, 1);
    state = observeReconnect(state, false, 0); assert.equal(state.revision, 1); assert.equal(state.active, true);
    assert.throws(() => observeReconnect(state, false, -1));
    assert.throws(() => parseReconnectState({...state, disconnects: [3, 2]}));
    assert.throws(() => parseReconnectState({...state, revision: 0}));
    assert.throws(() => parseReconnectState({...state, connected: true}));
    assert.throws(() => parseReconnectState({...state, disconnectedAt: 1}));
    assert.throws(() => parseReconnectState({...state, observedAt: undefined}));
});
