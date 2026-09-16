import type {DirectorySnapshot} from '../../integrations/threema/overlay/src/headless/node-directory-types.ts';
export type {DirectorySnapshot};

export function parseDirectory(value: unknown): DirectorySnapshot {
    let bytes = 0;
    let members = 0;
    function row(value: unknown, keys: string[]): Record<string, unknown> {
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).some((key) => !keys.includes(key))
        )
            throw new Error('Invalid directory record');
        return value as Record<string, unknown>;
    }
    function text(value: unknown): string {
        if (typeof value !== 'string' || value.length > 16384)
            throw new Error('Invalid directory text');
        bytes += Buffer.byteLength(value);
        if (bytes > 16 * 1024 * 1024) throw new Error('Directory exceeds limits');
        return value;
    }
    function identity(value: unknown): string {
        const id = text(value);
        if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(id)) throw new Error('Invalid directory identity');
        return id;
    }
    function state(value: unknown): number {
        if (value !== 0 && value !== 1 && value !== 2) throw new Error('Invalid directory state');
        return value;
    }
    function list(value: unknown): unknown[] {
        if (!Array.isArray(value) || value.length > 100000)
            throw new Error('Invalid directory list');
        return value;
    }
    const source = row(value, ['contacts', 'groups']);
    const seenContacts = new Set<string>();
    const contacts = list(source.contacts).map((value) => {
        const contact = row(value, [
            'identity',
            'firstName',
            'lastName',
            'displayName',
            'verification',
            'activity',
            'blocked',
        ]);
        const id = identity(contact.identity);
        if (seenContacts.has(id) || typeof contact.blocked !== 'boolean')
            throw new Error('Invalid directory contact');
        seenContacts.add(id);
        return {
            identity: id,
            firstName: text(contact.firstName),
            lastName: text(contact.lastName),
            displayName: text(contact.displayName),
            verification: state(contact.verification),
            activity: state(contact.activity),
            blocked: contact.blocked,
        };
    });
    const seenGroups = new Set<string>();
    const groups = list(source.groups).map((value) => {
        const group = row(value, [
            'groupKey',
            'creatorIdentity',
            'groupId',
            'name',
            'memberIdentities',
            'userState',
        ]);
        const creatorIdentity = identity(group.creatorIdentity);
        if (
            typeof group.groupId !== 'bigint' ||
            group.groupId < 0n ||
            group.groupId > 0xffffffffffffffffn
        )
            throw new Error('Invalid group ID');
        const encoded = Buffer.alloc(8);
        encoded.writeBigUInt64LE(group.groupId);
        const groupKey = `g:${creatorIdentity}:${encoded.toString('hex')}`;
        if (group.groupKey !== groupKey || seenGroups.has(groupKey))
            throw new Error('Invalid group key');
        seenGroups.add(groupKey);
        const memberIdentities = list(group.memberIdentities).map((value) => {
            if (++members > 100000) throw new Error('Directory membership exceeds limits');
            return identity(value);
        });
        if (new Set(memberIdentities).size !== memberIdentities.length)
            throw new Error('Duplicate group membership');
        return {
            groupKey,
            creatorIdentity,
            groupId: group.groupId,
            name: text(group.name),
            memberIdentities,
            userState: state(group.userState),
        };
    });
    return {contacts, groups};
}
