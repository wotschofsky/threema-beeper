import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RoomStateRouter} from '../src/service/room-state-router.ts';
import type {InboxEvent} from '../src/matrix/transaction-inbox.ts';

await test('room crypto state follows restored membership, join/leave and serialized initialization', async () => {
    const room = '!owned:invalid',
        bot = '@bot:invalid',
        ghost = '@ghost:invalid';
    const router = new RoomStateRouter(bot, (value) => value === room);
    const calls: string[] = [];
    let rejectGhost = false;
    const client = (name: string, rooms: string[]) => ({
        getJoinedRooms: async () => rooms,
        crypto: {
            isReady: true,
            onRoomJoin: async () => {
                calls.push(name + ':join');
            },
            onRoomEvent: async () => {
                if (name === 'ghost' && rejectGhost) throw new Error('synthetic failure');
                calls.push(name);
            },
        },
    });
    const event: InboxEvent = {
        room_id: room,
        event_id: '$state',
        sender: '@owner:invalid',
        type: 'm.room.encryption',
        state_key: '',
        content: {algorithm: 'm.megolm.v1.aes-sha2'},
    };
    await router.register(bot, client('bot', []));
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    const registering = router.register(ghost, {
        ...client('ghost', [room]),
        getJoinedRooms: async () => {
            await ready;
            return [room];
        },
    });
    const processing = router.apply(event);
    release();
    await Promise.all([registering, processing]);
    assert.deepEqual(calls.splice(0), ['ghost:join', 'bot', 'ghost']);
    await router.register('@unrelated:invalid', client('unrelated', ['!other:invalid']));
    await router.apply({...event, room_id: '!other:invalid'});
    assert.deepEqual(calls, []);
    rejectGhost = true;
    await assert.rejects(router.apply(event), /synthetic failure/);
    rejectGhost = false;
    calls.length = 0;
    await router.apply(event);
    assert.deepEqual(calls.splice(0), ['bot', 'ghost']);
    const membership = {
        ...event,
        type: 'm.room.member',
        state_key: ghost,
        content: {membership: 'leave'},
    };
    await router.apply(membership);
    calls.length = 0;
    await router.apply(event);
    assert.deepEqual(calls.splice(0), ['bot']);
    await router.apply({...membership, content: {membership: 'join'}});
    assert.deepEqual(calls.splice(0), ['bot', 'ghost:join', 'ghost']);
    await router.apply(event);
    assert.deepEqual(calls.splice(0), ['bot', 'ghost']);
    router.left(ghost, room);
    await router.apply(event);
    assert.deepEqual(calls.splice(0), ['bot']);
    router.joined(ghost, room);
    await router.apply(event);
    assert.deepEqual(calls.splice(0), ['bot', 'ghost']);
    router.clear();
    await assert.rejects(router.apply(event), /unavailable/);
});
