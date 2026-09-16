import {parseDirectory, type DirectorySnapshot} from './directory.ts';
import {parseConversations, type ConversationSummary} from './conversations.ts';

export interface ProfileMetadata {
    directory: DirectorySnapshot;
    chats: ConversationSummary[];
}
export function encodeMetadata(value: ProfileMetadata): string {
    const directory = parseDirectory(value.directory);
    const chats = parseConversations(value.chats);
    const body = JSON.stringify({
        version: 1,
        directory: {
            ...directory,
            groups: directory.groups.map((group) => ({
                ...group,
                groupId: group.groupId.toString(),
            })),
        },
        chats,
    });
    if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error('Metadata exceeds limits');
    return body;
}
export function decodeMetadata(body: string): ProfileMetadata {
    if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error('Metadata exceeds limits');
    const value = JSON.parse(body) as {
        version?: unknown;
        directory?: {groups?: unknown};
        chats?: unknown;
    };
    if (
        !value ||
        typeof value !== 'object' ||
        value.version !== 1 ||
        Object.keys(value).sort().join(',') !== 'chats,directory,version' ||
        !value.directory ||
        !Array.isArray(value.directory.groups) ||
        value.directory.groups.length > 100000
    )
        throw new Error('Invalid metadata envelope');
    const groups = value.directory.groups.map((group: unknown) => {
        if (!group || typeof group !== 'object' || Array.isArray(group))
            throw new Error('Invalid stored group');
        const row = group as Record<string, unknown>;
        if (typeof row.groupId !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(row.groupId))
            throw new Error('Invalid stored group ID');
        return {...row, groupId: BigInt(row.groupId)};
    });
    return {
        directory: parseDirectory({...value.directory, groups}),
        chats: parseConversations(value.chats),
    };
}
