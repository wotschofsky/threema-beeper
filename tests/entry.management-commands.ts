import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseManagementCommand} from '../src/management/commands.ts';
import {ManagementCommandHandler} from '../src/management/command-handler.ts';
import type {InboxEvent} from '../src/matrix/transaction-inbox.ts';

await test('management parser accepts only documented commands and upstream ASCII identity syntax', () => {
    assert.deepEqual(parseManagementCommand('!threema pm abcd1234'), {
        kind: 'pm',
        identity: 'ABCD1234',
    });
    assert.deepEqual(parseManagementCommand('pm *echo123'), {kind: 'pm', identity: '*ECHO123'});
    assert.deepEqual(parseManagementCommand('!threema contacts after abcd1234'), {
        kind: 'contacts',
        after: 'ABCD1234',
    });
    for (const body of [
        'pm ßabcd123',
        'pm ABCD1234 extra',
        'status\nresync',
        'x'.repeat(257),
        'pm ABC*1234',
        'contacts after ßabcd123',
        'contacts after ABCD1234 extra',
        'contacts 2',
    ])
        assert.equal(parseManagementCommand(body).kind, 'invalid');
    assert.equal(parseManagementCommand('!threema password do-not-echo').kind, 'local-only');
});
await test('management handler enforces encrypted owner room and fresh authorization without secret-command execution', async () => {
    const event: InboxEvent = {
        event_id: '$command',
        room_id: '!management:invalid',
        sender: '@owner:invalid',
        encrypted: true,
        type: 'm.room.message',
        content: {msgtype: 'm.text', body: 'resync'},
    };
    let authorized = false,
        executed = 0;
    const replies: string[] = [];
    const handler = new ManagementCommandHandler({
        owner: event.sender,
        room: event.room_id,
        authorize: async () => {
            if (!authorized) throw new Error('not authorized');
        },
        execute: async (command, id) => {
            assert.equal(command.kind, 'resync');
            assert.equal(id, event.event_id);
            executed++;
            return {msgtype: 'm.notice', body: 'Reconciliation requested.'};
        },
        reply: async (_id, content) => {
            replies.push(JSON.stringify(content));
        },
    });
    for (const changed of [
        {...event, encrypted: false},
        {...event, sender: '@other:invalid'},
        {...event, room_id: '!other:invalid'},
        {...event, content: {...event.content, 'm.relates_to': {rel_type: 'm.replace'}}},
    ])
        assert.equal(await handler.handle(changed), false);
    await assert.rejects(handler.handle(event));
    assert.equal(executed, 0);
    authorized = true;
    assert.equal(await handler.handle(event), true);
    assert.equal(executed, 1);
    await handler.handle({...event, content: {msgtype: 'm.text', body: 'password SECRET-CONTENT'}});
    assert.equal(executed, 1);
    assert(!replies.join('').includes('SECRET-CONTENT'));
});
