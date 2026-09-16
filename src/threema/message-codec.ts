import {parseHistoryPage, type NormalizedNodeMessage} from './history.ts';

const dateFields = [
    'createdAt',
    'receivedAt',
    'sentAt',
    'deliveredAt',
    'readAt',
    'editedAt',
    'deletedAt',
] as const;
function validate(value: unknown): NormalizedNodeMessage {
    const chatId = (value as {chatId?: unknown} | null)?.chatId;
    if (typeof chatId !== 'string') throw new Error('Invalid stored message');
    return parseHistoryPage({messages: [value]}, {chatId, limit: 1}).messages[0]!;
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        return `{${Object.keys(row)
            .filter((key) => row[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Versioned JSON. Date fields use epoch milliseconds; ordinals use canonical decimal strings. */
export function encodeMessage(value: NormalizedNodeMessage): string {
    const message = validate(value);
    const encoded: Record<string, unknown> = {
        ...message,
        ordinal: message.ordinal.toString(),
        reactions: message.reactions.map((reaction) => ({
            ...reaction,
            reactedAt: reaction.reactedAt.getTime(),
        })),
    };
    for (const key of dateFields) encoded[key] = message[key]?.getTime();
    return canonical({version: 1, message: encoded});
}

export function decodeMessage(text: string): NormalizedNodeMessage {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
        throw new Error('Stored message exceeds limits');
    let envelope: unknown;
    try {
        envelope = JSON.parse(text);
    } catch {
        throw new Error('Invalid stored message JSON');
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
        throw new Error('Invalid stored message envelope');
    const root = envelope as Record<string, unknown>;
    if (
        root.version !== 1 ||
        Object.keys(root).sort().join(',') !== 'message,version' ||
        !root.message ||
        typeof root.message !== 'object' ||
        Array.isArray(root.message)
    )
        throw new Error('Unsupported stored message envelope');
    const message = root.message as Record<string, unknown>;
    if (typeof message.ordinal !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(message.ordinal))
        throw new Error('Invalid stored ordinal');
    message.ordinal = BigInt(message.ordinal);
    for (const key of dateFields) {
        if (message[key] !== undefined) message[key] = decodeDate(message[key]);
    }
    if (!Array.isArray(message.reactions) || message.reactions.length > 10000)
        throw new Error('Invalid stored reactions');
    message.reactions = message.reactions.map((reaction) => {
        if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction))
            throw new Error('Invalid stored reaction');
        return {...reaction, reactedAt: decodeDate(reaction.reactedAt)};
    });
    return validate(message);
}
function decodeDate(value: unknown): Date {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        Math.abs(value) > 8640000000000000
    )
        throw new Error('Invalid stored timestamp');
    return new Date(value);
}
