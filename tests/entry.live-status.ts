import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {bridgeStatus} from '../src/service/bridge-status.ts';
import {liveStatus} from '../src/service/live-status.ts';

await test('local status checks authentication, freshness and profile without exposing identity', async () => {
    const owner = '@owner:example.invalid',
        identity = 'TEST1234';
    let body: unknown = bridgeStatus(owner, identity, {live: true, ready: true, syncLive: true});
    let redirect = false;
    let calls = 0;
    const server = createServer((req, res) => {
        calls++;
        assert.equal(req.url, '/_threema/bridge-state');
        assert.equal(req.headers.authorization, 'Bearer synthetic-token');
        if (redirect) {
            res.writeHead(302, {Location: 'http://127.0.0.1:1/'});
            res.end();
            return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const options = {port: address.port, token: 'synthetic-token', owner, identity};
    try {
        const result = await liveStatus(options);
        assert.equal(result.healthy, true);
        assert.equal(JSON.stringify(result).includes(identity), false);
        assert.equal(JSON.stringify(result).includes(owner), false);
        body = bridgeStatus(owner, identity, {live: true, ready: false, syncLive: true});
        assert.equal((await liveStatus(options)).healthy, false);
        body = bridgeStatus(owner, 'OTHER123', {live: true, ready: true, syncLive: true});
        await assert.rejects(liveStatus(options), /identity/);
        body = bridgeStatus(
            owner,
            identity,
            {live: true, ready: true, syncLive: true},
            Date.now() - 120000,
        );
        await assert.rejects(liveStatus(options), /expired/);
        body = 'x'.repeat(65536);
        await assert.rejects(liveStatus(options), /size limit/);
        redirect = true;
        await assert.rejects(liveStatus(options));
        assert.equal(calls, 6);
    } finally {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
    }
});
