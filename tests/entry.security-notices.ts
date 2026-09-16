import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {SecurityNotices} from '../src/operations/security-notices.ts';
import {readSecurityScanState, recordSecurityScan} from '../src/operations/security-scan-store.ts';
import {advanceSecurityScan, type SecurityScanState} from '../src/operations/security-scan.ts';
import {ProfileLock} from '../src/threema/profile-lock.ts';
const imageId = 'sha256:' + 'a'.repeat(64);
await test('persisted scan survives restart; locks and corrupt state prevent replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scan-state-'));
    try {
        assert.equal(await readSecurityScanState(directory), undefined);
        const original = await recordSecurityScan(directory, {imageId, findings: [{key: 'b'.repeat(64), severity: 'High'}]});
        assert.deepEqual(await readSecurityScanState(directory), original);
        assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
        const failed = await recordSecurityScan(directory);
        assert.deepEqual(failed.scan, original.scan);
        assert.deepEqual(await recordSecurityScan(directory), failed);
        const lock = new ProfileLock(join(directory, 'coordination'));
        try { await assert.rejects(recordSecurityScan(directory), /already open/); }
        finally { lock.close(); }
        assert.deepEqual(await readSecurityScanState(directory), failed);
        await writeFile(join(directory, 'state.json'), 'corrupt');
        await assert.rejects(recordSecurityScan(directory));
        assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), 'corrupt');
    } finally { await rm(directory, {recursive: true, force: true}); }
});
await test('result CLI rejects wrong-image reports and preserves the last successful scan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scan-cli-'));
    const run = async (body: string) => {
        const child = spawn(process.execPath, [resolve('src/service/entry.security-scan-result.ts'), directory, imageId], {stdio: ['pipe', 'pipe', 'pipe']});
        const exited = once(child, 'exit');
        child.stdin.end(body);
        return (await exited)[0];
    };
    try {
        assert.equal(await run(JSON.stringify({source: {type: 'image', target: {imageID: imageId}}, matches: []})), 0);
        const clean = await readSecurityScanState(directory);
        assert.equal(await run(JSON.stringify({source: {type: 'image', target: {imageID: 'sha256:' + 'c'.repeat(64)}}, matches: []})), 1);
        const failed = await readSecurityScanState(directory);
        assert.equal(failed?.lastResult, 'failed');
        assert.deepEqual(failed?.scan, clean?.scan);
        assert.equal(failed?.pending?.kind, 'failed');
    } finally { await rm(directory, {recursive: true, force: true}); }
});
await test('notification retries preserve ID and content through recovery; acknowledged notices stay quiet', async () => {
    let state: SecurityScanState | undefined;
    let ready = true, authorized = 0, lose = true;
    const acknowledged = new Set<string>();
    const attempts: {id: string; content: Record<string, unknown>}[] = [];
    const options = {
        owner: '@owner:example.invalid', ready: () => ready, load: async () => state,
        delivered: (id: string) => acknowledged.has(id),
        authorize: async () => { authorized++; return '!management:example.invalid'; },
        send: async (id: string, _room: string, content: Record<string, unknown>) => {
            attempts.push({id, content});
            if (lose) { lose = false; throw new Error('Lost response'); }
            acknowledged.add(id);
        },
    };
    assert.equal(await new SecurityNotices(options).drain(), 0);
    assert.equal(authorized, 0);
    state = advanceSecurityScan(undefined);
    await assert.rejects(new SecurityNotices(options).drain(), /Lost response/);
    state = advanceSecurityScan(state, {imageId, findings: []});
    assert.equal(await new SecurityNotices(options).drain(), 1);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(await new SecurityNotices(options).drain(), 0);
    state = advanceSecurityScan(state, {imageId, findings: [{key: 'd'.repeat(64), severity: 'Critical'}]});
    ready = false;
    assert.equal(await new SecurityNotices(options).drain(), 0);
    ready = true;
    await assert.rejects(new SecurityNotices({...options, authorize: async () => { throw new Error('Unauthorized'); }}).drain(), /Unauthorized/);
    assert.equal(attempts.length, 2);
    assert.equal(await new SecurityNotices(options).drain(), 1);
    assert.match(String(attempts[2]!.content.body), /1 new or increased-severity/);
});
