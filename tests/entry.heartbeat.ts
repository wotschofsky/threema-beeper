import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, symlink, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {heartbeat, heartbeatUrl, readHeartbeatUrl} from '../src/operations/heartbeat.ts';

await test('external pings require fresh healthy status and never forward status details', async () => {
    const url = heartbeatUrl('https://monitor.invalid/secret-token');
    let calls = 0;
    const request: typeof fetch = async (destination, options) => {
        calls++;
        assert.equal(String(destination), url.href);
        assert.equal(options?.method, 'GET');
        assert.equal(options?.body, undefined);
        assert.equal(options?.headers, undefined);
        assert.equal(options?.redirect, 'error');
        assert.equal(options?.credentials, 'omit');
        assert(options?.signal instanceof AbortSignal);
        return new Response(null, {status: 204});
    };
    assert.equal(await heartbeat(url, async () => ({healthy: false}), request), 'unhealthy');
    assert.equal(await heartbeat(url, async () => { throw new Error('private details'); }, request), 'check-failed');
    assert.equal(calls, 0);
    assert.equal(await heartbeat(url, async () => ({healthy: true}), request), 'sent');
    assert.equal(calls, 1);
    assert.equal(await heartbeat(url, async () => ({healthy: true}), async () => new Response('private provider body', {status: 503})), 'ping-failed');
    assert.equal(await heartbeat(url, async () => ({healthy: true}), async () => { throw new Error('secret URL'); }), 'ping-failed');
});

await test('heartbeat URL must be HTTPS in a bounded private owned regular file', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'threema-heartbeat-')));
    const file = join(directory, 'url');
    try {
        await writeFile(file, 'https://monitor.invalid/secret\n', {mode: 0o600});
        assert.equal((await readHeartbeatUrl(file)).href, 'https://monitor.invalid/secret');
        await chmod(file, 0o644);
        await assert.rejects(readHeartbeatUrl(file));
        await chmod(file, 0o600);
        await symlink(file, join(directory, 'link'));
        await assert.rejects(readHeartbeatUrl(join(directory, 'link')));
        await assert.rejects(readHeartbeatUrl(directory));
        await writeFile(file, 'x'.repeat(4098));
        await assert.rejects(readHeartbeatUrl(file));
        for (const value of ['http://monitor.invalid/secret', 'https://user:pass@monitor.invalid', 'https://monitor.invalid/#secret', 'https://monitor.invalid/a\nb', 'not-a-url'])
            assert.throws(() => heartbeatUrl(value));
    } finally { await rm(directory, {recursive: true, force: true}); }
});
