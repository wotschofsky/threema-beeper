import assert from 'node:assert/strict';
import {test} from 'node:test';
import {managementRoomState, assertManagementRoomState} from '../src/management/room-policy.ts';

await test('management room policy requires encryption, exclusive membership and restricted administration', () => {
    const identity = {profile: 'SELF1234', owner: '@owner:invalid', bot: '@bot:invalid'};
    const valid: any[] = [
        ...managementRoomState(identity).map((event) => ({...event, sender: identity.bot})),
        ...[identity.owner, identity.bot].map((user) => ({
            type: 'm.room.member',
            state_key: user,
            content: {membership: 'join'},
        })),
    ];
    assert.doesNotThrow(() => assertManagementRoomState(valid, identity));
    for (const membership of ['join', 'invite', 'knock'])
        assert.throws(() =>
            assertManagementRoomState(
                [
                    ...valid,
                    {type: 'm.room.member', state_key: '@other:invalid', content: {membership}},
                ],
                identity,
            ),
        );
    for (const [type, field, value] of [
        ['m.room.encryption', 'algorithm', 'other'],
        ['m.room.join_rules', 'join_rule', 'public'],
        ['m.room.history_visibility', 'history_visibility', 'world_readable'],
        ['m.room.power_levels', 'invite', 0],
        ['com.threema.management', 'owner', '@other:invalid'],
    ] as const) {
        const changed = structuredClone(valid);
        changed.find((event) => event.type === type).content[field] = value;
        assert.throws(() => assertManagementRoomState(changed, identity));
    }
    assert.throws(() => assertManagementRoomState([...valid, valid[0]], identity));
    assert.throws(() =>
        assertManagementRoomState(
            valid.filter((event) => event.state_key !== identity.owner),
            identity,
        ),
    );
    const changed = structuredClone(valid);
    changed.find((event) => event.type === 'm.room.power_levels').content.events = {
        'com.threema.management': 0,
    };
    assert.throws(() => assertManagementRoomState(changed, identity));
});
