import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {createTransactionServer} from '../src/matrix/transaction-server.ts';

await test('loopback appservice authenticates, bounds input, and durably accepts retries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-http-inbox-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const token = randomBytes(32).toString('hex');
    let live = true,
        ready = false,
        probeFailure = false;
    let fresh = 0;
    const recoveries: string[] = [];
    const server = createTransactionServer(
        inbox,
        token,
        1024,
        () => {
            if (probeFailure) throw new Error('synthetic private health failure');
            return {live, ready, private: 'must not be exposed'};
        },
        () => {
            if (probeFailure) throw new Error('synthetic private metrics failure');
            return {
                live,
                ready,
                syncLive: ready,
                proxyUp: false,
                uptimeSeconds: 12,
                residentBytes: 1024,
                private: 'must not be exposed',
            };
        },
        () => {
            fresh++;
        },
        () => ({state_event: ready ? 'CONNECTED' : 'TRANSIENT_DISCONNECT'}),
        (action) => {
            recoveries.push(action);
            return {action};
        },
    );
    try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}/_matrix/app/v1/transactions/synthetic`;
        const base = `http://127.0.0.1:${address.port}`;
        const recovery = base + '/_threema/recovery';
        assert.equal(
            (await fetch(recovery, {method: 'POST', body: JSON.stringify({action: 'retry'})}))
                .status,
            401,
        );
        assert.deepEqual(recoveries, []);
        for (const action of ['resync', 'retry']) {
            const result = await fetch(recovery, {
                method: 'POST',
                headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                body: JSON.stringify({action}),
            });
            assert.equal(result.status, 200);
            assert.deepEqual(await result.json(), {action});
        }
        assert.equal(
            (
                await fetch(recovery, {
                    method: 'POST',
                    headers: {Authorization: 'Bearer ' + token},
                    body: JSON.stringify({action: 'resend-unknown'}),
                })
            ).status,
            400,
        );
        for (const action of [['retry'], ['resync'], {toString: 'retry'}, null, 1, true]) {
            const malformed = await fetch(recovery, {
                method: 'POST', headers: {Authorization: 'Bearer ' + token},
                body: JSON.stringify({action}),
            });
            assert.equal(malformed.status, 400, 'Recovery action must be a literal string');
            assert.deepEqual(await malformed.json(), {errcode: 'M_UNKNOWN'});
        }
        assert.deepEqual(recoveries, ['resync', 'retry']);
        const accountStatus = base + '/_threema/bridge-state';
        assert.equal((await fetch(accountStatus)).status, 401);
        const privateStatus = await fetch(accountStatus, {
            headers: {Authorization: 'Bearer ' + token},
        });
        assert.equal(privateStatus.status, 200);
        assert.equal(privateStatus.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await privateStatus.json(), {state_event: 'TRANSIENT_DISCONNECT'});
        const metrics = await fetch(base + '/metrics');
        assert.equal(metrics.status, 200);
        assert.ok(metrics.headers.get('content-type')!.includes('version=0.0.4'));
        const exposition = await metrics.text();
        assert.ok(exposition.includes('bridge_ready 0\n'));
        assert.ok(exposition.includes('bbctl_proxy_up 0\n'));
        assert.ok(!exposition.includes('private'));
        assert.equal(await (await fetch(base + '/metrics', {method: 'HEAD'})).text(), '');
        probeFailure = true;
        const failedMetrics = await fetch(base + '/metrics');
        assert.equal(failedMetrics.status, 503);
        assert.ok(!(await failedMetrics.text()).includes('private'));
        probeFailure = false;
        assert.equal((await fetch(base + '/livez')).status, 200);
        const notReady = await fetch(base + '/readyz');
        assert.equal(notReady.status, 503);
        assert.deepEqual(await notReady.json(), {ok: false});
        ready = true;
        const healthy = await fetch(base + '/readyz');
        assert.equal(healthy.status, 200);
        assert.equal(healthy.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await healthy.json(), {ok: true});
        const head = await fetch(base + '/readyz', {method: 'HEAD'});
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        probeFailure = true;
        assert.equal((await fetch(base + '/readyz')).status, 503);
        probeFailure = false;
        live = false;
        assert.equal((await fetch(base + '/livez')).status, 503);
        live = true;
        const send = (body: string, authorization = `Bearer ${token}`) =>
            fetch(url, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json', 'Authorization': authorization},
                body,
            });
        assert.equal((await send('{"events":[]}', 'Bearer wrong')).status, 401);
        assert.equal(inbox.next(), undefined);
        assert.equal(fresh, 0);
        assert.equal((await send('not json')).status, 400);
        assert.equal((await send('{"events":[{}]}')).status, 400);
        assert.equal((await send(' '.repeat(1025))).status, 413);
        const chunked = await fetch(url, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(' '.repeat(1025)));
                    controller.close();
                },
            }),
            duplex: 'half',
        } as RequestInit);
        assert.equal(chunked.status, 413);
        const invalidValues = [null, {}, [], false, -1, '', 'x'.repeat(1025)];
        const requiredFields = ['event_id', 'room_id', 'sender', 'type'];
        for (let iteration = 0; iteration < 128; iteration++) {
            const event = {
                event_id: '$synthetic', room_id: '!synthetic', sender: '@synthetic',
                type: 'm.room.encrypted', content: {},
                [requiredFields[iteration % requiredFields.length]!]: invalidValues[iteration % invalidValues.length],
            };
            const body = JSON.stringify({events: [event]});
            const result = await send(body);
            assert.equal(result.status, Buffer.byteLength(body) > 1024 ? 413 : 400);
            assert.deepEqual(await result.json(), {errcode: 'M_UNKNOWN'});
        }
        let nested: unknown = 'synthetic';
        for (let depth = 0; depth < 40; depth++) nested = {nested};
        const tooDeep = await send(JSON.stringify({events: [], nested}));
        assert.equal(tooDeep.status, 400);
        assert.deepEqual(await tooDeep.json(), {errcode: 'M_UNKNOWN'});
        assert.equal(inbox.next(), undefined, 'Rejected requests must never reach durable storage');
        assert.equal(fresh, 0, 'Rejected requests must never trigger transient callbacks');
        assert.equal((await send('{"events":[]}')).status, 200);
        assert.equal(inbox.next()?.id, 'synthetic');
        assert.equal((await send('{ "events" : [] }')).status, 200);
        assert.equal((await send('{"events":[],"different":true}')).status, 409);
        assert.equal(fresh, 1, 'retries and conflicts do not replay transient events');
        inbox.close();
        const reopened = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
        assert.equal(reopened.next()?.id, 'synthetic');
        reopened.close();
        const unavailable = await send('{"events":[]}');
        assert.equal(unavailable.status, 503);
        assert.equal((await unavailable.text()).includes('database'), false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
