import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startSetupServer} from '../src/setup/setup-server.ts';
import type {SetupState} from '../src/setup/link-session.ts';

await test('local setup URL is single-use and requires same-origin authenticated requests', async () => {
    let state: SetupState = {state: 'idle'};
    let stopped = false;
    const server = await startSetupServer({
        get state() {
            return state;
        },
        begin: async () => {
            state = {state: 'ready', identity: 'TEST1234'};
        },
        cancel: async () => {
            stopped = true;
        },
        stop: async () => {
            stopped = true;
        },
        recoverySecret: () => 'synthetic-secret',
        finish: (accepted) => {
            if (!accepted) throw new Error('Unconfirmed');
            state = {state: 'finished'};
        },
    });
    const url = new URL(server.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('setup');
    const post = (path: string, body: unknown, cookie = '', origin = url.origin) =>
        fetch(url.origin + path, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Origin': origin, 'Cookie': cookie},
            body: JSON.stringify(body),
        });
    try {
        const page = await fetch(url.origin);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
        assert.match(await page.text(), /id="qr"/);
        const script = await fetch(url.origin + '/setup.js');
        assert.equal(script.status, 200);
        assert.match(await script.text(), /history.replaceState/);
        assert.equal((await fetch(url.origin + '/constructor')).status, 401);
        assert.equal((await fetch(url.origin + '/qr')).status, 401);
        assert.equal((await fetch(url.origin + '/state')).status, 401);
        assert.equal((await post('/session', {token}, '', 'https://attacker.invalid')).status, 403);
        const claim = await post('/session', {token});
        assert.equal(claim.status, 200);
        const cookie = claim.headers.get('set-cookie')!.split(';')[0]!;
        assert.ok(claim.headers.get('set-cookie')!.includes('HttpOnly'));
        assert.equal((await post('/session', {token})).status, 401);
        assert.equal((await post('/begin', {}, cookie, 'https://attacker.invalid')).status, 403);
        assert.equal((await post('/begin', {}, cookie)).status, 202);
        const response = await fetch(url.origin + '/state', {headers: {Cookie: cookie}});
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), {state: 'ready', identity: 'TEST1234'});
        state = {state: 'qr', uri: 'threema://synthetic-join-data'};
        const png = await fetch(url.origin + '/qr', {headers: {Cookie: cookie}});
        assert.equal(png.status, 200);
        assert.equal(png.headers.get('content-type'), 'image/png');
        assert.equal(png.headers.get('cache-control'), 'no-store');
        const bytes = Buffer.from(await png.arrayBuffer());
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16), 320);
        state = {state: 'ready', identity: 'TEST1234'};
        assert.equal((await post('/finish', {recoverySaved: false}, cookie)).status, 409);
        assert.equal((await post('/finish', {recoverySaved: true}, cookie)).status, 200);
        await server.close();
        assert.equal(stopped, false, 'Finishing setup must preserve the linked backend');
    } finally {
        await server.close();
    }
});

await test(
    'expired local setup stops unfinished work without an explicit close',
    {timeout: 5000},
    async () => {
        let stopped!: () => void;
        const expired = new Promise<void>((resolve) => {
            stopped = resolve;
        });
        const server = await startSetupServer(
            {
                state: {state: 'idle'},
                begin: async () => undefined,
                cancel: async () => {
                    stopped();
                },
                stop: async () => {
                    stopped();
                },
                recoverySecret: () => '',
                finish: () => undefined,
            },
            {inactivityMs: 20},
        );
        try {
            await expired;
        } finally {
            await server.close();
        }
    },
);
