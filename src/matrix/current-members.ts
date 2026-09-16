import {
    MembershipEvent,
    type MatrixClient,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';

/** Read current encryption recipients from room state when the server lacks /members. */
export function useCurrentRoomMembers(client: MatrixClient): void {
    const original = client.getRoomMembers.bind(client);
    const originalBy = client.getRoomMembersByMembership.bind(client);
    const originalWithout = client.getRoomMembersWithoutMembership.bind(client);
    client.getRoomMembersByMembership = (room, membership, batch) =>
        batch
            ? originalBy(room, membership, batch)
            : client.getRoomMembers(room, undefined, [membership]);
    client.getRoomMembersWithoutMembership = (room, membership, batch) =>
        batch
            ? originalWithout(room, membership, batch)
            : client.getRoomMembers(room, undefined, undefined, [membership]);
    client.getRoomMembers = async (room, batch, membership, notMembership) => {
        // Historical membership must retain its token semantics.
        if (batch) return original(room, batch, membership, notMembership);
        const state = await client.getRoomState(room);
        if (!Array.isArray(state)) throw new Error('Invalid room state snapshot');
        return state
            .filter((event) => {
                if (event.type !== 'm.room.member') return false;
                const member = event.content?.membership;
                if (
                    typeof member !== 'string' ||
                    typeof event.state_key !== 'string' ||
                    !/^@[^\s:]+:[^\s]+$/.test(event.state_key) ||
                    !['join', 'invite', 'leave', 'ban', 'knock'].includes(member)
                )
                    throw new Error('Invalid room membership snapshot');
                return (
                    (!membership?.length || membership.some((value) => value === member)) &&
                    (!notMembership?.length || !notMembership.some((value) => value === member))
                );
            })
            .map((event) => new MembershipEvent(event));
    };
}
