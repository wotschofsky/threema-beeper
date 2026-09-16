import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {MatrixOutboxIngress} from '../src/outbox/matrix-ingress.ts';
import {OutboxDispatcher} from '../src/outbox/dispatcher.ts';

await test(
    'dispatcher queues during reconciliation, passes retained inbox events and stops without dispatching the next request',
    {timeout: 10_000},
    async (context) => {
        const directory = await mkdtemp(join(tmpdir(), 'threema-dispatcher-'));
        const key = randomBytes(32),
            inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key),
            portals = new PortalStore(join(directory, 'portals.sqlite'), key),
            store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
        const profile = 'SELF1234',
            owner = '@owner:invalid',
            room = '!room:invalid';
        portals.bind(profile, 'c:TEST1234', room);
        for (let index = 0; index < 7; index++) {
            inbox.accept(`txn${index}`, {});
            inbox.complete(`txn${index}`, [
                {
                    event_id: `$event${index}`,
                    room_id: room,
                    sender: owner,
                    encrypted: true,
                    type: index < 5 ? 'm.room.member' : 'm.room.message',
                    ...(index < 5 ? {state_key: owner} : {}),
                    content:
                        index < 5
                            ? {membership: 'join'}
                            : {msgtype: 'm.text', body: `fixture${index}`},
                },
            ]);
        }
        let ready = false,
            calls = 0,
            release!: () => void,
            finished = false;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const states: string[] = [];
        const dispatcher = new OutboxDispatcher({
            store,
            ingress: new MatrixOutboxIngress({inbox, outbox: store, portals, profile, owner}),
            ready: () => ready,
            intervalMs: 10,
            batchSize: 2,
            onState: (state) => {
                states.push(state);
                if (state === 'waiting') throw new Error('synthetic observer failure');
            },
            sender: {
                send: async (_request, persist) => {
                    calls++;
                    const ids = [`m:${calls.toString(16).padStart(16, '0')}`];
                    await persist(ids);
                    if (calls === 1) await held;
                    finished = true;
                    return ids;
                },
            },
        });
        const until = async (predicate: () => boolean) => {
            while (!predicate()) await delay(5, undefined, {signal: context.signal});
        };
        try {
            dispatcher.start();
            dispatcher.start();
            await until(() => inbox.pendingEvents().length === 5);
            assert.equal(calls, 0);
            assert.equal(store.nextPrepared()!.request.eventId, '$event5');
            ready = true;
            await until(() => calls === 1);
            const stopping = dispatcher.stop();
            await delay(15, undefined, {signal: context.signal});
            assert.equal(finished, false);
            assert.equal(calls, 1);
            release();
            await stopping;
            assert.equal(dispatcher.status, 'stopped');
            assert.equal(store.nextPrepared()!.request.eventId, '$event6');
            dispatcher.start();
            assert.equal(
                store.nextPrepared(),
                undefined,
                'Unconfirmed predecessor blocks this chat after restart',
            );
            assert.equal(calls, 1, 'Restart must not repeat the accepted send');
            store.observe(profile, 'c:TEST1234', 'm:0000000000000001');
            await until(() => calls === 2 && store.nextPrepared() === undefined);
            await dispatcher.stop();
            assert.equal(calls, 2);
            assert.equal(
                inbox.pendingEvents().length,
                5,
                'State inputs must remain for their own consumer',
            );
            assert.ok(states.includes('waiting'));
            assert.equal(states.at(-1), 'stopped');
        } finally {
            release();
            await dispatcher.stop();
            store.close();
            portals.close();
            inbox.close();
            key.fill(0);
            await rm(directory, {recursive: true, force: true});
        }
    },
);
