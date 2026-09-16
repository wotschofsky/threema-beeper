import assert from 'node:assert/strict';
import {test} from 'node:test';
import {StartDm} from '../src/management/start-dm.ts';

await test('start DM resolves before creating a stable contact portal and returns ghost metadata', async () => {
    const calls: string[] = [];
    let failJoin = true;
    const start = new StartDm(
        {
            ensureContact: async (identity) => {
                calls.push('lookup');
                assert.equal(identity, 'ABCD1234');
                return {
                    identity,
                    displayName: 'Contact',
                    firstName: '',
                    lastName: '',
                    verification: 0,
                    activity: 0,
                    blocked: false,
                };
            },
        },
        {
            ensure: async (chat) => {
                calls.push('portal');
                assert.equal(chat.chatId, 'c:ABCD1234');
                assert.equal(chat.name, 'Contact');
                return '!dm:invalid';
            },
        },
        {
            ensure: async (identity, name) => {
                calls.push('ghost');
                assert.equal(identity, 'ABCD1234');
                assert.equal(name, 'Contact');
                return {userId: '@ghost:invalid'} as any;
            },
            reconcile: async (room, chat, members) => {
                calls.push('join');
                assert.equal(room, '!dm:invalid');
                assert.equal(chat, 'c:ABCD1234');
                assert.deepEqual(members, ['ABCD1234']);
                if (failJoin) throw new Error('retry');
            },
        },
    );
    await assert.rejects(start.open('ßabcd123'));
    assert.deepEqual(calls, []);
    await assert.rejects(start.open('abcd1234'));
    assert.deepEqual(calls, ['lookup', 'portal', 'ghost', 'join']);
    failJoin = false;
    assert.deepEqual(await start.open('ABCD1234'), {room: '!dm:invalid', ghost: '@ghost:invalid'});
});
