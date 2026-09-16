import assert from 'node:assert/strict';
import {test} from 'node:test';
import {joinOwnerPortal} from '../src/matrix/owner-room-join.ts';

function fixture(membership = 'leave') {
    const calls: string[] = [];
    let active = true;
    let chat: string | undefined = 'c:TEST1234';
    const content = {
        bridgebot: '@bot:invalid',
        creator: '@owner:invalid',
        network: {id: 'SELF1234'},
        channel: {id: chat},
    };
    const state = [
        {type: 'm.bridge', state_key: 'threema://bridge', sender: '@bot:invalid', content},
        {type: 'm.room.encryption', state_key: '', content: {algorithm: 'm.megolm.v1.aes-sha2'}},
        {type: 'm.room.member', state_key: '@owner:invalid', content: {membership}},
    ].map((event, index) => ({
        ...event,
        sender: event.sender ?? '@bot:invalid',
        event_id: '$state' + index,
        room_id: '!room:invalid',
        origin_server_ts: 1,
        unsigned: {},
    }));
    const options: Parameters<typeof joinOwnerPortal>[0] = {
        room: '!room:invalid',
        profile: 'SELF1234',
        owner: '@owner:invalid',
        botId: '@bot:invalid',
        active: () => active,
        mappedChat: () => chat,
        bot: {
            getRoomState: async () => {
                calls.push('state');
                return state;
            },
            sendStateEvent: async (room, type, owner, content) => {
                assert.equal(type, 'm.room.member');
                assert.deepEqual(content, {
                    'membership': 'invite',
                    'fi.mau.will_auto_accept': true,
                    'com.beeper.exclude_from_timeline': true,
                });
                assert.equal(owner, options.owner);
                assert.equal(room, options.room);
                calls.push('invite');
                return '$automatic-membership';
            },
        },
        ownerClient: {
            getWhoAmI: async () => {
                calls.push('identity');
                return {user_id: options.owner, device_id: 'existing'};
            },
            joinRoom: async (room) => {
                assert.equal(room, options.room);
                calls.push('join');
                return room;
            },
        },
    };
    return {
        options,
        calls,
        content,
        state,
        stop: () => {
            active = false;
        },
        unmap: () => {
            chat = undefined;
        },
    };
}

test('real conversations join directly, including rooms whose empty invitation was withdrawn', async () => {
    for (const [membership, expected] of [
        ['join', ['state']],
        ['invite', ['state', 'identity', 'join']],
        ['leave', ['state', 'identity', 'invite', 'join']],
    ] as const) {
        const value = fixture(membership);
        await joinOwnerPortal(value.options);
        assert.deepEqual(value.calls, expected);
    }
});

test('automatic joining rejects foreign or unencrypted portals before any membership changes', async () => {
    for (const corrupt of [
        (f: ReturnType<typeof fixture>) => {
            f.content.network.id = 'OTHER123';
        },
        (f: ReturnType<typeof fixture>) => {
            f.content.channel.id = 'c:OTHER123';
        },
        (f: ReturnType<typeof fixture>) => {
            f.content.creator = '@other:invalid';
        },
        (f: ReturnType<typeof fixture>) => {
            f.content.bridgebot = '@other:invalid';
        },
        (f: ReturnType<typeof fixture>) => {
            f.state.splice(1, 1);
        },
        (f: ReturnType<typeof fixture>) => f.unmap(),
    ]) {
        const value = fixture();
        corrupt(value);
        await assert.rejects(joinOwnerPortal(value.options), /Owner join/);
        assert.ok(value.calls.every((call) => call === 'state'));
    }
});

test('automatic joining verifies the owner and stops mutations after cancellation', async () => {
    const wrong = fixture();
    wrong.options.ownerClient.getWhoAmI = async () => ({
        user_id: '@other:invalid',
        device_id: 'existing',
    });
    await assert.rejects(joinOwnerPortal(wrong.options), /identity mismatch/);
    assert.deepEqual(wrong.calls, ['state']);
    for (const stage of ['state', 'identity', 'invite'] as const) {
        const value = fixture();
        if (stage === 'state')
            value.options.bot.getRoomState = async () => {
                value.stop();
                return value.state;
            };
        if (stage === 'identity')
            value.options.ownerClient.getWhoAmI = async () => {
                value.stop();
                return {user_id: value.options.owner, device_id: 'existing'};
            };
        if (stage === 'invite')
            value.options.bot.sendStateEvent = async () => {
                value.stop();
                return '$cancelled-membership';
            };
        await assert.rejects(joinOwnerPortal(value.options), /outside the active profile/);
        assert.ok(!value.calls.includes('join'));
    }
});
