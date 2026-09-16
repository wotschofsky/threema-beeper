import {isDeepStrictEqual} from 'node:util';
import {splitReplyText} from './reply-text.ts';

/** Validate a replacement against the original Matrix content before creating native commands. */
export function normalizeMutationContent(
    original: Record<string, unknown>,
    replacement: Record<string, unknown>,
    options: {audioFileFallback?: boolean} = {},
): string {
    original = structuredClone(original);
    replacement = structuredClone(replacement);
    if (
        !original ||
        !replacement ||
        Array.isArray(original) ||
        Array.isArray(replacement) ||
        original.msgtype !== replacement.msgtype ||
        typeof replacement.body !== 'string'
    )
        throw new Error('The replacement must preserve the message type.');
    const relation = (value: unknown) => {
        if (value === undefined) return undefined;
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid replacement relation.');
        const row = value as Record<string, unknown>;
        if (Object.keys(row).some((key) => key !== 'm.in_reply_to'))
            throw new Error('An edit cannot change message relations.');
        const reply = row['m.in_reply_to'];
        if (
            !reply ||
            typeof reply !== 'object' ||
            Array.isArray(reply) ||
            Object.keys(reply).some((key) => key !== 'event_id') ||
            typeof (reply as Record<string, unknown>).event_id !== 'string' ||
            !/^\$[^\s]{1,1024}$/.test((reply as {event_id: string}).event_id)
        )
            throw new Error('Invalid replacement reply target.');
        return (reply as {event_id: string}).event_id;
    };
    const reply = relation(original['m.relates_to']);
    if (relation(replacement['m.relates_to']) !== reply)
        throw new Error('An edit cannot change the reply target.');
    let text: string;
    if (original.msgtype === 'm.text') {
        text = reply ? splitReplyText(replacement.body).body : replacement.body;
        if (!text.trim()) throw new Error('A text message cannot be edited to empty content.');
    } else if (
        ['m.file', 'm.image', 'm.video'].includes(String(original.msgtype)) ||
        (original.msgtype === 'm.audio' && options.audioFileFallback === true)
    ) {
        // Matrix body is the filename when no explicit filename field is present.
        const filename = original.filename ?? original.body;
        const nextFilename = replacement.filename ?? replacement.body;
        if (typeof filename !== 'string' || !filename || filename !== nextFilename)
            throw new Error('An edit cannot rename the attachment.');
        const fixed = (content: Record<string, unknown>) => {
            const result = {...content};
            for (const key of ['body', 'filename', 'format', 'formatted_body']) delete result[key];
            return result;
        };
        if (!isDeepStrictEqual(fixed(original), fixed(replacement)))
            throw new Error('An edit can change only the attachment caption.');
        text = replacement.body === filename ? '' : replacement.body;
    } else throw new Error('This message type cannot be edited.');
    if (Buffer.byteLength(text) > 6000)
        throw new Error('The edited text exceeds the Threema message limit.');
    return text;
}
