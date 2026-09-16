export interface NodeTypingRequest {
    profile: string;
    chatId: string;
    typing: boolean;
}
export function parseTypingCommand(value: unknown): NodeTypingRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid typing request');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some((key) => !['profile', 'chatId', 'typing'].includes(key)) ||
        typeof row.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(row.profile) ||
        typeof row.chatId !== 'string' ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(row.chatId) ||
        typeof row.typing !== 'boolean'
    )
        throw new Error('Invalid typing request');
    return {profile: row.profile, chatId: row.chatId, typing: row.typing};
}
