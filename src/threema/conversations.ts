export interface ConversationSummary {
    chatId: string;
    name: string;
    unreadCount: number;
    archived: boolean;
    pinned: boolean;
    lastMessageId?: string;
}

const identity = '[A-Z0-9*][A-Z0-9]{7}';
const chatPattern = new RegExp(`^(?:c:${identity}|g:${identity}:[0-9a-f]{16})$`);

/** Validate the plain-data boundary. Backend stores, controllers and keys never cross it. */
export function parseConversations(value: unknown): ConversationSummary[] {
    if (!Array.isArray(value) || value.length > 100000)
        throw new Error('Invalid conversation list');
    const seen = new Set<string>();
    let bytes = 0;
    return value.map((item: unknown) => {
        if (!item || typeof item !== 'object') throw new Error('Invalid conversation');
        const row = item as Record<string, unknown>;
        if (
            typeof row.chatId !== 'string' ||
            !chatPattern.test(row.chatId) ||
            seen.has(row.chatId) ||
            typeof row.name !== 'string' ||
            row.name.length > 16384 ||
            typeof row.unreadCount !== 'number' ||
            !Number.isSafeInteger(row.unreadCount) ||
            row.unreadCount < 0 ||
            typeof row.archived !== 'boolean' ||
            typeof row.pinned !== 'boolean' ||
            (row.archived && row.pinned) ||
            (row.lastMessageId !== undefined &&
                (typeof row.lastMessageId !== 'string' ||
                    !/^m:[0-9a-f]{16}$/.test(row.lastMessageId)))
        )
            throw new Error('Invalid conversation');
        bytes += Buffer.byteLength(row.chatId) + Buffer.byteLength(row.name);
        if (typeof row.lastMessageId === 'string') bytes += Buffer.byteLength(row.lastMessageId);
        if (bytes > 16 * 1024 * 1024) throw new Error('Conversation list exceeds limits');
        seen.add(row.chatId);
        return {
            chatId: row.chatId,
            name: row.name,
            unreadCount: row.unreadCount,
            archived: row.archived,
            pinned: row.pinned,
            lastMessageId: row.lastMessageId as string | undefined,
        };
    });
}
