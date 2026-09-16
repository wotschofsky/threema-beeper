export interface ManagementRoomIdentity {
    profile: string;
    owner: string;
    bot: string;
}

function validateIdentity(identity: ManagementRoomIdentity): void {
    if (
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(identity.profile) ||
        !/^@[^\s]+:[^\s]+$/.test(identity.owner) ||
        !/^@[^\s]+:[^\s]+$/.test(identity.bot) ||
        identity.owner === identity.bot
    )
        throw new Error('Invalid management room identity');
}

/** State required when provisioning the dedicated room; command text remains owner-sendable. */
export function managementRoomState(identity: ManagementRoomIdentity) {
    validateIdentity(identity);
    return [
        {type: 'm.room.encryption', state_key: '', content: {algorithm: 'm.megolm.v1.aes-sha2'}},
        {type: 'm.room.join_rules', state_key: '', content: {join_rule: 'invite'}},
        {type: 'm.room.history_visibility', state_key: '', content: {history_visibility: 'joined'}},
        {type: 'm.room.guest_access', state_key: '', content: {guest_access: 'forbidden'}},
        {
            type: 'com.threema.management',
            state_key: '',
            content: {profile: identity.profile, owner: identity.owner},
        },
        {
            type: 'm.room.power_levels',
            state_key: '',
            content: {
                users: {[identity.bot]: 100, [identity.owner]: 0},
                users_default: 0,
                events_default: 0,
                state_default: 100,
                invite: 100,
                kick: 100,
                ban: 100,
                redact: 100,
            },
        },
    ];
}

/** Validate a freshly fetched complete room state; never fall back to cached authorization. */
export function assertManagementRoomState(value: unknown, identity: ManagementRoomIdentity): void {
    assertRoomState(value, identity, false);
}

/** Provisioning may finish while the owner invitation is pending; this does not authorize commands. */
export function assertProvisionedManagementRoomState(
    value: unknown,
    identity: ManagementRoomIdentity,
): void {
    assertRoomState(value, identity, true);
}

function assertRoomState(
    value: unknown,
    identity: ManagementRoomIdentity,
    allowInvitation: boolean,
): void {
    validateIdentity(identity);
    try {
        if (!Array.isArray(value) || value.length > 10000) throw new Error();
        const one = (type: string, key = '') => {
            const rows = value.filter((event) => event?.type === type && event.state_key === key);
            if (rows.length !== 1 || !rows[0].content || typeof rows[0].content !== 'object')
                throw new Error();
            return rows[0];
        };
        for (const expected of managementRoomState(identity).slice(0, 4)) {
            const actual = one(expected.type).content;
            for (const [key, expectedValue] of Object.entries(expected.content))
                if (actual[key] !== expectedValue) throw new Error();
        }
        const marker = one('com.threema.management');
        if (
            marker.sender !== identity.bot ||
            marker.content.profile !== identity.profile ||
            marker.content.owner !== identity.owner
        )
            throw new Error();
        if (one('m.room.member', identity.bot).content.membership !== 'join') throw new Error();
        const ownerMembership = one('m.room.member', identity.owner).content.membership;
        if (ownerMembership !== 'join' && !(allowInvitation && ownerMembership === 'invite'))
            throw new Error();
        const members = new Set<string>();
        for (const event of value.filter((event) => event?.type === 'm.room.member')) {
            if (typeof event.state_key !== 'string' || members.has(event.state_key))
                throw new Error();
            members.add(event.state_key);
            const membership = event.content?.membership;
            if (!['join', 'invite', 'leave', 'ban', 'knock'].includes(membership))
                throw new Error();
            if (
                event.state_key !== identity.owner &&
                event.state_key !== identity.bot &&
                !['leave', 'ban'].includes(membership)
            )
                throw new Error();
        }
        const power = one('m.room.power_levels').content;
        if (
            power.users?.[identity.bot] !== 100 ||
            (power.users?.[identity.owner] ?? power.users_default ?? 0) !== 0 ||
            (power.users_default ?? 0) !== 0 ||
            power.state_default !== 100 ||
            (power.events_default ?? 0) !== 0
        )
            throw new Error();
        for (const name of ['invite', 'kick', 'ban', 'redact'])
            if (power[name] !== 100) throw new Error();
        for (const [user, level] of Object.entries(power.users ?? {}))
            if (user !== identity.bot && level !== 0) throw new Error();
        for (const [type, level] of Object.entries(power.events ?? {})) {
            if (type === 'm.room.message' || type === 'm.room.encrypted') {
                if (level !== 0) throw new Error();
            } else if (level !== 100) throw new Error();
        }
    } catch {
        throw new Error('Management room authorization failed');
    }
}
