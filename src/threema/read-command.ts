export interface ReadCommand {
    profile: string;
    chatId: string;
    messageId: string;
}
export function parseReadCommand(value: unknown): ReadCommand {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid read command');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some((k) => !['profile', 'chatId', 'messageId'].includes(k)) ||
        typeof row.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(row.profile) ||
        typeof row.chatId !== 'string' ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(row.chatId) ||
        typeof row.messageId !== 'string' ||
        !/^m:[0-9a-f]{16}$/.test(row.messageId)
    )
        throw new Error('Invalid read command');
    return {profile: row.profile, chatId: row.chatId, messageId: row.messageId};
}
