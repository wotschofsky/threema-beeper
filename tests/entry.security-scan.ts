import assert from 'node:assert/strict';
import {test} from 'node:test';
import {advanceSecurityScan, parseSecurityScan, parseSecurityScanState} from '../src/operations/security-scan.ts';
const imageId = 'sha256:' + 'a'.repeat(64);
const match = (id = 'CVE-test-1', severity = 'High') => ({
    vulnerability: {id, namespace: 'test:synthetic', severity},
    artifact: {name: 'synthetic-package', version: '1.0.0', type: 'npm'},
});
const report = (matches: unknown[]) => ({source: {type: 'image', target: {imageID: imageId}}, matches});
const scan = (matches: unknown[]) => parseSecurityScan(report(matches), imageId);
await test('scan provenance, suppression, bounds and fields fail closed', () => {
    const input = report([match()]);
    assert.throws(() => parseSecurityScan(input, 'sha256:' + 'b'.repeat(64)));
    assert.throws(() => parseSecurityScan({...input, source: {type: 'directory'}}, imageId));
    assert.throws(() => parseSecurityScan({...input, ignoredMatches: [match()]}, imageId));
    assert.throws(() => scan([match('id', 'Invalid')]));
    assert.throws(() => scan([{...match(), artifact: {}}]));
    assert.throws(() => scan(Array(100_001).fill(match())));
    assert.throws(() => scan([match('x'.repeat(4097))]));
    assert.equal(parseSecurityScan({...input, ignoredMatches: []}, imageId).findings.length, 1);
});
await test('new and increased findings alert, duplicates/order and resolution stay quiet', () => {
    const first = advanceSecurityScan(undefined, scan([match(), match('second', 'Low')]));
    assert.deepEqual(first.pending, {revision: 1, kind: 'findings', count: 2});
    const repeated = advanceSecurityScan(first, scan([match('second', 'Low'), match(), match()]));
    assert.deepEqual(repeated, first);
    const elevated = advanceSecurityScan(repeated, scan([match(), match('second', 'Critical')]));
    assert.deepEqual(elevated.pending, {revision: 2, kind: 'findings', count: 1});
    const resolved = advanceSecurityScan(elevated, scan([]));
    assert.equal(resolved.revision, 2);
    assert.deepEqual(resolved.pending, elevated.pending); // Delivery may still be outstanding.
    const recurring = advanceSecurityScan(resolved, scan([match()]));
    assert.equal(recurring.revision, 3);
    assert.equal(recurring.pending?.count, 1);
    const duplicate = scan([match('same', 'Low'), match('same', 'High')]);
    assert.equal(duplicate.findings.length, 1);
    assert.equal(duplicate.findings[0]!.severity, 'High');
});
await test('failure repeats are quiet, recovery preserves pending notice and later failures alert', () => {
    const clean = advanceSecurityScan(undefined, scan([]));
    assert.equal(clean.pending, undefined);
    const failure = advanceSecurityScan(clean);
    assert.deepEqual(failure.pending, {revision: 1, kind: 'failed', count: 0});
    assert.deepEqual(advanceSecurityScan(failure), failure);
    const recovered = advanceSecurityScan(failure, scan([]));
    assert.deepEqual(recovered.pending, failure.pending);
    assert.deepEqual(advanceSecurityScan(recovered).pending, {revision: 2, kind: 'failed', count: 0});
    const populated = advanceSecurityScan(undefined, scan([match()]));
    assert.deepEqual(advanceSecurityScan(populated).scan, populated.scan);
});
await test('saved state rejects invalid revision, findings and pending records', () => {
    const state = advanceSecurityScan(undefined, scan([match()]));
    assert.throws(() => parseSecurityScanState({...state, revision: -1}));
    assert.throws(() => parseSecurityScanState({...state, pending: {...state.pending, revision: 0}}));
    assert.throws(() => parseSecurityScanState({...state, scan: {...state.scan, findings: [...state.scan!.findings, ...state.scan!.findings]}}));
    assert.throws(() => advanceSecurityScan({schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER, lastResult: 'success'}));
});
