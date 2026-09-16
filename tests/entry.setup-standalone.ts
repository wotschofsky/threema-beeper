import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {SetupState} from '../src/setup/link-session.ts';
import {runStandaloneSetup} from '../src/setup/standalone.ts';

for (const finish of [false, true]) {
    await test(
        `standalone setup ${finish ? 'finishes and releases' : 'interrupts and releases'} its backend`,
        {timeout: 5000},
        async () => {
            let state: SetupState = {state: 'idle'};
            let stops = 0;
            let cancels = 0;
            const abort = new AbortController();
            let publish!: (url: string) => void;
            const urlReady = new Promise<string>((resolve) => {
                publish = resolve;
            });
            const running = runStandaloneSetup(
                {
                    get state() {
                        return state;
                    },
                    begin: async () => {
                        state = {state: 'ready', identity: 'TEST1234'};
                    },
                    cancel: async () => {
                        cancels++;
                        state = {state: 'cancelled'};
                    },
                    stop: async () => {
                        stops++;
                    },
                    recoverySecret: () => 'synthetic',
                    finish: (saved) => {
                        assert.ok(saved);
                        state = {state: 'finished'};
                    },
                },
                {signal: abort.signal, onUrl: publish},
            );
            try {
                const url = new URL(
                    await Promise.race([
                        urlReady,
                        running.then(() => {
                            throw new Error('Premature exit');
                        }),
                    ]),
                );
                if (finish) {
                    const post = (path: string, body: unknown, cookie = '') =>
                        fetch(url.origin + path, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Origin': url.origin,
                                'Cookie': cookie,
                            },
                            body: JSON.stringify(body),
                        });
                    const claim = await post('/session', {
                        token: new URLSearchParams(url.hash.slice(1)).get('setup'),
                    });
                    const cookie = claim.headers.get('set-cookie')!.split(';')[0]!;
                    assert.equal((await post('/begin', {}, cookie)).status, 202);
                    assert.equal(
                        (await post('/finish', {recoverySaved: true}, cookie)).status,
                        200,
                    );
                } else abort.abort();
                assert.equal(await running, finish ? 'finished' : 'interrupted');
                assert.equal(stops, 1);
                assert.equal(cancels, finish ? 0 : 1);
                await assert.rejects(fetch(url.origin + '/state'), 'Listener must be closed');
            } finally {
                abort.abort();
                await running;
            }
        },
    );
}

await test(
    'standalone setup lets the authenticated browser read a terminal linking error',
    {timeout: 5000},
    async () => {
        let state: SetupState = {state: 'idle'};
        const abort = new AbortController();
        let publish!: (url: string) => void;
        const published = new Promise<string>((resolve) => {
            publish = resolve;
        });
        const running = runStandaloneSetup(
            {
                get state() {
                    return state;
                },
                begin: async () => {},
                cancel: async () => {},
                stop: async () => {},
                finish: () => {},
                recoverySecret: () => 'synthetic',
            },
            {signal: abort.signal, onUrl: publish},
        );
        try {
            const url = new URL(await published);
            const claim = await fetch(url.origin + '/session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': url.origin,
                },
                body: JSON.stringify({token: new URLSearchParams(url.hash.slice(1)).get('setup')}),
            });
            const cookie = claim.headers.get('set-cookie')!.split(';')[0]!;
            state = {state: 'error', code: 'profile-saved-link-interrupted'};
            // A normal browser poll can arrive after the standalone coordinator notices failure.
            await new Promise((resolve) => setTimeout(resolve, 250));
            assert.equal((await fetch(url.origin + '/state')).status, 401);
            const response = await fetch(url.origin + '/state', {headers: {Cookie: cookie}});
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), state);
            assert.equal(await running, 'error');
        } finally {
            abort.abort();
            await running;
        }
    },
);
