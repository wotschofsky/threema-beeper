import type {NormalizedNodeMessage} from '../../integrations/threema/overlay/src/headless/node-message-types.ts';
export type {NormalizedNodeMessage};
export interface HistoryCursor {
    ordinal: string;
    messageId: string;
}
export interface HistoryRequest {
    chatId: string;
    limit: number;
    after?: HistoryCursor;
}
export interface HistoryPage {
    messages: NormalizedNodeMessage[];
    next?: HistoryCursor;
}

function boundedPage(value: unknown): boolean {
    const pending = [{value, depth: 0}];
    let nodes = 0;
    let bytes = 0;
    while (pending.length > 0) {
        const item = pending.pop()!;
        if (++nodes > 100000 || item.depth > 12) return false;
        if (typeof item.value === 'string') bytes += Buffer.byteLength(item.value);
        if (bytes > 16 * 1024 * 1024) return false;
        if (item.value && typeof item.value === 'object' && !(item.value instanceof Date)) {
            for (const child of Object.values(item.value)) {
                if (pending.length + nodes >= 100000) return false;
                pending.push({value: child, depth: item.depth + 1});
            }
        }
    }
    return true;
}

type Check = (value: unknown) => boolean;
const string =
    (max: number, pattern?: RegExp): Check =>
    (value) =>
        typeof value === 'string' && value.length <= max && (!pattern || pattern.test(value));
const identity = string(8, /^[A-Z0-9*][A-Z0-9]{7}$/);
const messageId = string(18, /^m:[0-9a-f]{16}$/);
const chatId = string(27, /^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/);
const integer: Check = (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const signedInteger: Check = (value) => typeof value === 'number' && Number.isSafeInteger(value);
const date: Check = (value) => value instanceof Date && Number.isFinite(value.getTime());
const boolean: Check = (value) => typeof value === 'boolean';
const optional =
    (check: Check): Check =>
    (value) =>
        value === undefined || check(value);
const array =
    (check: Check, max: number): Check =>
    (value) =>
        Array.isArray(value) && value.length <= max && value.every(check);
const record =
    (fields: Record<string, Check>): Check =>
    (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        return (
            Object.keys(row).every((key) => Object.hasOwn(fields, key)) &&
            Object.entries(fields).every(([key, check]) => check(row[key]))
        );
    };
const cursor = record({ordinal: string(16, /^(?:0|[1-9][0-9]{0,15})$/), messageId});
const validCursor: Check = (value) =>
    cursor(value) && BigInt((value as HistoryCursor).ordinal) <= BigInt(Number.MAX_SAFE_INTEGER);
const request = record({
    chatId,
    limit: (value) => integer(value) && (value as number) >= 1 && (value as number) <= 500,
    after: optional(validCursor),
});
export function parseHistoryRequest(value: unknown): HistoryRequest {
    if (!request(value)) throw new Error('Invalid history request');
    return structuredClone(value) as HistoryRequest;
}
const mediaFields = {
    type: string(5, /^(?:image|video|audio|file)$/),
    mimeType: string(255),
    fileName: optional(string(16384)),
    byteSize: integer,
    caption: optional(string(1048576)),
    blobRef: optional(string(130, /^b:[0-9a-f]+$/)),
    thumbnailRef: optional(string(130, /^b:[0-9a-f]+$/)),
    thumbnailMimeType: optional(string(255)),
    dimensions: optional(record({width: integer, height: integer})),
    durationSeconds: optional(
        (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    ),
};
const content: Check = (value) => {
    if (!value || typeof value !== 'object') return false;
    switch ((value as {type?: unknown}).type) {
        case 'text':
            return record({type: string(4, /^text$/), text: string(1048576)})(value);
        case 'deleted':
            return record({type: string(7, /^deleted$/)})(value);
        case 'unsupported':
            return record({type: string(11, /^unsupported$/), description: string(4096)})(value);
        case 'image':
        case 'video':
        case 'audio':
        case 'file':
            return record(mediaFields)(value);
        case 'poll':
            return record({
                type: string(4, /^poll$/),
                pollId: string(16, /^[0-9a-f]{16}$/),
                creatorIdentity: identity,
                description: string(1048576),
                state: integer,
                answerType: integer,
                announceType: integer,
                displayMode: integer,
                choicesType: integer,
                messageType: integer,
                choices: array(
                    record({
                        id: signedInteger,
                        description: string(1048576),
                        sortKey: integer,
                        totalVotes: optional(integer),
                        votes: array(record({senderIdentity: identity, selected: boolean}), 10000),
                    }),
                    10000,
                ),
            })(value);
        default:
            return false;
    }
};
const message = record({
    messageId,
    chatId,
    direction: string(8, /^(?:inbound|outbound)$/),
    senderIdentity: identity,
    createdAt: date,
    receivedAt: optional(date),
    sentAt: optional(date),
    deliveredAt: optional(date),
    readAt: optional(date),
    editedAt: optional(date),
    deletedAt: optional(date),
    ordinal: (value) =>
        typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    replyToMessageId: optional(messageId),
    reactions: array(
        record({senderIdentity: identity, emoji: string(128), reactedAt: date}),
        10000,
    ),
    content,
});

/** Validate and detach all returned records, including page ordering and cursor continuity. */
export function parseHistoryPage(value: unknown, requested: HistoryRequest): HistoryPage {
    const input = parseHistoryRequest(requested);
    if (!boundedPage(value)) throw new Error('History page exceeds limits');
    if (!record({messages: array(message, input.limit), next: optional(validCursor)})(value))
        throw new Error('Invalid history page');
    const page = value as HistoryPage;
    let previous = input.after;
    const seen = new Set<string>();
    for (const row of page.messages) {
        if (
            row.chatId !== input.chatId ||
            seen.has(row.messageId) ||
            (previous !== undefined &&
                (row.ordinal < BigInt(previous.ordinal) ||
                    (row.ordinal === BigInt(previous.ordinal) &&
                        row.messageId <= previous.messageId)))
        )
            throw new Error('Invalid history order');
        seen.add(row.messageId);
        previous = {ordinal: row.ordinal.toString(), messageId: row.messageId};
    }
    if (
        page.next &&
        (page.messages.length !== input.limit ||
            page.next.ordinal !== previous?.ordinal ||
            page.next.messageId !== previous.messageId)
    )
        throw new Error('Invalid history continuation');
    return structuredClone(page);
}
