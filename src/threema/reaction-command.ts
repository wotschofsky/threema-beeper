import type {NodeReactionRequest} from '../../integrations/threema/overlay/src/headless/node-reaction-types.ts';
export type {NodeReactionRequest};

/** The worker additionally validates the emoji against the pinned upstream emoji set. */
export function parseReactionCommand(value: unknown): NodeReactionRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid reaction request');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some(
            (key) => !['profile', 'chatId', 'messageId', 'emoji', 'action'].includes(key),
        ) ||
        typeof row.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(row.profile) ||
        typeof row.chatId !== 'string' ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(row.chatId) ||
        typeof row.messageId !== 'string' ||
        !/^m:[0-9a-f]{16}$/.test(row.messageId) ||
        typeof row.emoji !== 'string' ||
        !row.emoji ||
        Buffer.byteLength(row.emoji) > 128 ||
        (row.action !== 'apply' && row.action !== 'withdraw')
    )
        throw new Error('Invalid reaction request');
    return {
        profile: row.profile,
        chatId: row.chatId,
        messageId: row.messageId,
        emoji: row.emoji,
        action: row.action,
    };
}
