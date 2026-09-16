import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {ManagementWorker} from '../src/management/worker.ts';
import {ManagementActions} from '../src/management/actions.ts';
import {BackendWorkerError} from '../src/threema/backend-controller.ts';

await test('management results survive restart and reply failure without re-execution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'management-worker-'));
    const key = randomBytes(32);
    const filename = join(directory, 'inbox.sqlite');
    let inbox = new TransactionInbox(filename, key);
    try {
        const event = {
            event_id: '$command',
            room_id: '!management:invalid',
            sender: '@owner:invalid',
            encrypted: true,
            type: 'm.room.message',
            content: {msgtype: 'm.text', body: 'status'},
        };
        inbox.accept('transaction', {});
        inbox.complete('transaction', [event]);
        let executed = 0,
            authorized = true,
            failSend = true;
        const sends: {id: string; content: Record<string, unknown>}[] = [];
        const worker = () =>
            new ManagementWorker({
                inbox,
                room: event.room_id,
                owner: event.sender,
                ready: () => true,
                authorize: async () => {
                    if (!authorized) throw new Error('denied');
                },
                execute: async () => {
                    executed++;
                    return {msgtype: 'm.notice', body: 'Synthetic status'};
                },
                send: async (id, room, content) => {
                    assert.equal(room, event.room_id);
                    sends.push({id, content});
                    if (failSend) throw new Error('lost response');
                },
            });
        await assert.rejects(worker().drain());
        assert.equal(executed, 1);
        assert.equal(inbox.pendingCounts().events, 1);
        inbox.close();
        inbox = new TransactionInbox(filename, key);
        authorized = false;
        await assert.rejects(worker().drain());
        assert.equal(sends.length, 1);
        authorized = true;
        failSend = false;
        const restarted = worker();
        assert.deepEqual(await Promise.all([restarted.drain(), restarted.drain()]), [1, 1]);
        assert.equal(executed, 1);
        assert.deepEqual(sends[0], sends[1]);
        assert.equal(inbox.pendingCounts().events, 0);
        assert.throws(() =>
            inbox.saveManagementResult(event.event_id, {msgtype: 'm.notice', body: 'changed'}),
        );
        assert.throws(() =>
            inbox.saveManagementResult('$missing', {msgtype: 'm.notice', body: 'no event'}),
        );
        assert.throws(() =>
            inbox.saveManagementResult(event.event_id, {
                msgtype: 'm.notice',
                body: 'x'.repeat(65537),
            }),
        );
    } finally {
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('terminal contact rejection replies and releases later commands, while transport failures retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'management-rejection-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    try {
        const room = '!management:invalid',
            owner = '@owner:invalid';
        const events = ['pm ABCD1234', 'status'].map((body, index) => ({
            event_id: `$command${index}`,
            room_id: room,
            sender: owner,
            type: 'm.room.message',
            encrypted: true,
            content: {msgtype: 'm.text', body},
        }));
        inbox.accept('commands', {});
        inbox.complete('commands', events);
        let code = 'backend-operation-failed',
            lookups = 0;
        const sent: string[] = [];
        const actions = new ManagementActions({
            status: () => ({ready: true}),
            directory: async () => ({contacts: [], groups: []}),
            resync: () => true,
            doctor: async () => ({checks: []}),
            version: async () => ({source: {sha256: 'a'.repeat(64)}}),
            pm: async () => {
                lookups++;
                throw new BackendWorkerError(code);
            },
        });
        const worker = new ManagementWorker({
            inbox,
            room,
            owner,
            ready: () => true,
            authorize: async () => {},
            execute: (command, id) => actions.execute(command, id),
            send: async (_id, _room, content) => {
                sent.push(content.body as string);
            },
        });
        await assert.rejects(worker.drain());
        assert.equal(inbox.pendingEvents().length, 2);
        assert.equal(inbox.managementResult('$command0'), undefined);
        assert.equal(sent.length, 0);
        code = 'contact-unavailable';
        assert.equal(await worker.drain(), 2);
        assert.equal(lookups, 2);
        assert.deepEqual(sent, [
            'This Threema ID is unavailable. No chat was created.',
            'Bridge ready for messages.',
        ]);
        assert.equal(inbox.pendingEvents().length, 0);
        code = 'contact-is-self';
        const self = await actions.execute({kind: 'pm', identity: 'SELF1234'}, '$self');
        assert.match(self.body as string, /own Threema ID/);
    } finally {
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
