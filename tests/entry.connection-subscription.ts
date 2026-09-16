import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {receiveConnection, serveConnection} from '../src/threema/connection-subscription.ts';

await test(
    'connection stream preserves brief outages and reports channel loss',
    {timeout: 5000},
    async (context) => {
        const {port1, port2} = new MessageChannel();
        const states: boolean[] = [];
        let changed!: (connected: boolean) => void;
        let stops = 0;
        const receiver = receiveConnection(port1, (state) => states.push(state));
        try {
            await serveConnection(port2, async (callback) => {
                changed = callback;
                changed(true);
                return async () => {
                    stops++;
                };
            });
            changed(false);
            changed(true);
            while (states.length < 3) await delay(1, undefined, {signal: context.signal});
            assert.deepEqual(states, [true, false, true]);
            port2.close();
            while (states.length < 4 || stops < 1)
                await delay(1, undefined, {signal: context.signal});
            assert.deepEqual(states, [true, false, true, false]);
            await receiver.stop();
            assert.equal(stops, 1);
        } finally {
            receiver.dispose();
            port2.close();
        }
    },
);
