import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ManagementRoom} from '../src/management/room.ts';
import {managementRoomState} from '../src/management/room-policy.ts';

const identity = {profile: 'SELF1234', owner: '@owner:invalid', bot: '@bot:invalid'};
function fixture() {
    let exists = false;
    let creates = 0;
    let encrypted = false;
    let failure: string | undefined;
    let resolveFailure: string | undefined;
    const state: any[] = [
        ...managementRoomState(identity).map((event) => ({...event, sender: identity.bot})),
        {type: 'm.room.member', state_key: identity.bot, content: {membership: 'join'}},
        {type: 'm.room.member', state_key: identity.owner, content: {membership: 'invite'}},
    ];
    const intent = {
        userId: identity.bot,
        async enableEncryption() {
            encrypted = true;
        },
        underlyingClient: {
            async resolveRoom() {
                assert.ok(encrypted);
                if (resolveFailure) throw {errcode: resolveFailure};
                if (!exists) throw {errcode: 'M_NOT_FOUND'};
                return '!management:invalid';
            },
            async createRoom(options: any) {
                assert.ok(encrypted);
                creates++;
                assert.equal(options.visibility, 'private');
                assert.equal(options['com.beeper.auto_join_invites'], true);
                assert.deepEqual(options.invite, [identity.owner]);
                assert.deepEqual(options.initial_state, managementRoomState(identity));
                exists = true;
                if (failure) throw {errcode: failure};
                return '!management:invalid';
            },
            async getRoomState() {
                return state;
            },
        },
    };
    const manager = () =>
        new ManagementRoom(intent, {
            profile: identity.profile,
            owner: identity.owner,
            domain: 'invalid',
            namespace: 'threema',
            assertAlias: (alias) =>
                assert.match(alias, /^#threema_management_[a-f0-9]{40}:invalid$/),
        });
    return {
        manager,
        state,
        creates: () => creates,
        failCreate: (value: string) => {
            failure = value;
        },
        failResolve: (value?: string) => {
            resolveFailure = value;
        },
    };
}

await test('provision once concurrently and across restart; invite cannot authorize commands', async () => {
    const f = fixture();
    const room = f.manager();
    const [first, second] = await Promise.all([room.ensure(), room.ensure()]);
    assert.equal(first, second);
    assert.equal(await f.manager().ensure(), first);
    assert.equal(f.creates(), 1);
    await assert.rejects(room.authorize(first));
    f.state.find((event) => event.state_key === identity.owner).content.membership = 'join';
    await room.authorize(first);
    f.state.push({
        type: 'm.room.member',
        state_key: '@outsider:invalid',
        content: {membership: 'invite'},
    });
    await assert.rejects(room.authorize(first));
    await assert.rejects(room.ensure());
    assert.equal(f.creates(), 1);
});

await test('lost creation response recovers on retry without duplicating the room', async () => {
    const f = fixture();
    f.failCreate('NETWORK_ERROR');
    await assert.rejects(f.manager().ensure());
    assert.equal(await f.manager().ensure(), '!management:invalid');
    assert.equal(f.creates(), 1);
});

await test('alias races recover but permissions and transport errors never trigger creation', async () => {
    const f = fixture();
    f.failResolve('M_FORBIDDEN');
    const manager = f.manager();
    await assert.rejects(manager.ensure());
    assert.equal(f.creates(), 0);
    f.failResolve();
    f.failCreate('M_ROOM_IN_USE');
    await manager.ensure();
    assert.equal(f.creates(), 1);
    f.state.find((event) => event.type === 'com.threema.management').sender = '@other:invalid';
    await assert.rejects(manager.ensure());
    assert.equal(f.creates(), 1);
});

await test('existing-room lookup is quiet when absent and validates rooms across restart', async () => {
    const f = fixture();
    assert.equal(await f.manager().find(), undefined);
    assert.equal(f.creates(), 0);
    const id = await f.manager().ensure();
    assert.equal(await f.manager().find(), id);
    assert.equal(f.creates(), 1);
    f.failResolve('M_FORBIDDEN');
    await assert.rejects(f.manager().find());
    f.failResolve();
    f.state.find(event => event.type === 'com.threema.management').sender = '@other:invalid';
    await assert.rejects(f.manager().find());
    assert.equal(f.creates(), 1);
});
