import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {useCurrentRoomMembers} from '../src/matrix/current-members.ts';

test('current recipient snapshot filters room state and preserves historical membership requests', async () => {
    const client = new MatrixClient('https://matrix.invalid', 'fixture');
    const calls: unknown[] = [];
    client.getRoomMembers = async (...args) => {
        calls.push(args);
        return [];
    };
    const state: any[] = ['join', 'invite', 'leave', 'ban'].map((membership, i) => ({
        type: 'm.room.member',
        state_key: `@user${i}:matrix.invalid`,
        event_id: `$member${i}`,
        sender: '@bot:matrix.invalid',
        origin_server_ts: 1,
        content: {membership},
    }));
    client.getRoomState = async () => state;
    useCurrentRoomMembers(client);
    const members = await client.getRoomMembers('!room:matrix.invalid', undefined, [
        'join',
        'invite',
    ]);
    assert.deepEqual(
        members.map((member) => member.membershipFor),
        ['@user0:matrix.invalid', '@user1:matrix.invalid'],
    );
    assert.equal(calls.length, 0);
    assert.equal(
        (await client.getRoomMembersByMembership('!room:matrix.invalid', 'join')).length,
        1,
    );
    assert.equal(
        (await client.getRoomMembersWithoutMembership('!room:matrix.invalid', 'leave')).length,
        3,
    );
    assert.equal(
        (
            await client.getRoomMembers('!room:matrix.invalid', undefined, undefined, [
                'leave',
                'ban',
            ])
        ).length,
        2,
    );
    await client.getRoomMembers('!room:matrix.invalid', 'historical-token', ['join']);
    assert.deepEqual(calls, [['!room:matrix.invalid', 'historical-token', ['join'], undefined]]);
    state.push({type: 'm.room.member', content: {membership: 'join'}});
    await assert.rejects(client.getRoomMembers('!room:matrix.invalid'), /Invalid room membership/);
});
