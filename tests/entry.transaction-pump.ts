import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {TransactionWorker} from '../src/matrix/transaction-worker.ts';
import {TransactionPump, type PumpState} from '../src/matrix/transaction-pump.ts';

await test(
    'startup recovery retries persisted work and shutdown waits for the active decoder',
    {timeout: 5000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-pump-'));
        const key = randomBytes(32);
        let inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
        inbox.accept('persisted-before-start', {events: []});
        inbox.close();
        inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const active = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const states: PumpState[] = [];
        const worker = new TransactionWorker(inbox, async () => {
            calls++;
            if (calls === 1) throw new Error('synthetic disconnected crypto client');
            entered();
            await gate;
        });
        const pump = new TransactionPump(worker, {
            intervalMs: 10,
            retryMs: 10,
            onState: (state) => {
                states.push(state);
            },
        });
        try {
            pump.start();
            pump.start();
            await active;
            assert.ok(states.includes('retrying'));
            let stopped = false;
            const stopping = pump.stop().then(() => {
                stopped = true;
            });
            await Promise.resolve();
            assert.equal(stopped, false, 'Shutdown must wait for the current decoder');
            release();
            await stopping;
            assert.equal(pump.status, 'stopped');
            assert.equal(calls, 2);
            assert.equal(inbox.next(), undefined);
        } finally {
            release();
            await pump.stop();
            inbox.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'persistent outages back off and a successful recovery resets the delay',
    {timeout: 5000},
    async () => {
        const times: number[] = [];
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const pump = new TransactionPump(
            {
                drain: async () => {
                    times.push(performance.now());
                    if (times.length === 3) return 0;
                    if (times.length === 5) {
                        finish();
                        return 0;
                    }
                    throw Error('offline');
                },
            },
            {intervalMs: 10, retryMs: 40},
        );
        try {
            pump.start();
            await done;
            assert.ok(times[2]! - times[1]! >= 70, 'Second retry must back off');
            assert.ok(times[4]! - times[3]! >= 30, 'Recovered retry must retain minimum delay');
            assert.ok(times[4]! - times[3]! < 150, 'Success must reset the backoff');
        } finally {
            await pump.stop();
        }
    },
);
