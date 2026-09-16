import type {InboxEvent} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboundAttachmentInput} from './outbound-attachment.ts';

export interface OutboundMedia {
    chat: string;
    kind: 'm.file' | 'm.image' | 'm.video' | 'm.audio';
    filename: string;
    caption?: string;
    replyTo?: string;
    mimeType: string;
    bytes?: number;
    file: OutboundAttachmentInput['file'] & {url: string};
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid media metadata');
    return value as Record<string, unknown>;
}
function base64(value: unknown, bytes: number, url = false): string {
    if (
        typeof value !== 'string' ||
        !(url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/).test(value)
    )
        throw new Error('Invalid encrypted media descriptor');
    const decoded = Buffer.from(value, url ? 'base64url' : 'base64');
    if (
        decoded.length !== bytes ||
        decoded.toString(url ? 'base64url' : 'base64').replace(/=+$/, '') !==
            value.replace(/=+$/, '')
    )
        throw new Error('Invalid encrypted media descriptor');
    return value;
}

/** Pure classification. Neither downloads nor acknowledges events, and never trusts client MIME alone. */
export function resolveOutboundMedia(
    event: InboxEvent,
    options: {
        profile: string;
        owner: string;
        maximumBytes: number;
        portals: Pick<PortalStore, 'portalForRoom'>;
    },
):
    | {kind: 'ignore'}
    | {kind: 'rejected'; reason: string}
    | {kind: 'resolved'; media: OutboundMedia} {
    if (
        event.sender !== options.owner ||
        event.state_key !== undefined ||
        event.type !== 'm.room.message' ||
        !['m.file', 'm.image', 'm.video', 'm.audio'].includes(String(event.content.msgtype))
    )
        return {kind: 'ignore'};
    const portal = options.portals.portalForRoom(event.room_id);
    if (portal?.profile !== options.profile) return {kind: 'ignore'};
    try {
        if (
            !Number.isSafeInteger(options.maximumBytes) ||
            options.maximumBytes < 1 ||
            options.maximumBytes > 1024 ** 3
        )
            throw new Error('Media sending is unavailable.');
        if (event.encrypted !== true) throw new Error('An encrypted attachment event is required.');
        const content = event.content,
            info = object(content.info),
            file = object(content.file),
            key = object(file.key),
            hashes = object(file.hashes);
        if (
            (content.url !== undefined && content.url !== file.url) ||
            file.v !== 'v2' ||
            key.kty !== 'oct' ||
            key.alg !== 'A256CTR' ||
            !Array.isArray(key.key_ops) ||
            !key.key_ops.includes('decrypt')
        )
            throw new Error('An encrypted attachment is required.');
        if (
            typeof file.url !== 'string' ||
            file.url.length > 2048 ||
            !/^mxc:\/\/[^\s/?#@]+\/[A-Za-z0-9._~-]{1,255}$/.test(file.url)
        )
            throw new Error('The attachment location is invalid.');
        const host = file.url.slice(6).split('/')[0]!;
        const parsedHost = new URL(`https://${host}`);
        if (parsedHost.username || parsedHost.password || parsedHost.pathname !== '/')
            throw new Error('The attachment location is invalid.');
        if (
            typeof info.mimetype !== 'string' ||
            info.mimetype.length > 127 ||
            !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(info.mimetype)
        )
            throw new Error('The attachment MIME type is invalid.');
        if (
            info.size !== undefined &&
            (!Number.isSafeInteger(info.size) ||
                (info.size as number) < 0 ||
                (info.size as number) > options.maximumBytes)
        )
            throw new Error('The attachment exceeds the size limit or has an invalid size.');
        if (typeof content.body !== 'string' || Buffer.byteLength(content.body) > 65536)
            throw new Error('The attachment description is invalid.');
        const name = content.filename ?? content.body;
        if (
            typeof name !== 'string' ||
            !name ||
            Buffer.byteLength(name) > 1024 ||
            /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(name) ||
            name === '.' ||
            name === '..'
        )
            throw new Error('The attachment filename is invalid.');
        let replyTo: string | undefined;
        if (content['m.relates_to'] !== undefined) {
            const relation = object(content['m.relates_to']);
            const reply = object(relation['m.in_reply_to']);
            if (
                relation.rel_type !== undefined ||
                typeof reply.event_id !== 'string' ||
                !/^\$[^\s]{1,1024}$/.test(reply.event_id)
            )
                throw new Error('The attachment relation is unsupported.');
            replyTo = reply.event_id;
        }
        return {
            kind: 'resolved',
            media: {
                chat: portal.chat,
                kind: content.msgtype as OutboundMedia['kind'],
                filename: name,
                ...(content.filename !== undefined && content.body !== name
                    ? {caption: content.body}
                    : {}),
                ...(replyTo ? {replyTo} : {}),
                mimeType: info.mimetype.toLowerCase(),
                ...(info.size === undefined ? {} : {bytes: info.size as number}),
                file: {
                    url: file.url,
                    v: 'v2',
                    key: {
                        kty: 'oct',
                        alg: 'A256CTR',
                        key_ops: ['decrypt'],
                        k: base64(key.k, 32, true),
                    },
                    iv: base64(file.iv, 16),
                    hashes: {sha256: base64(hashes.sha256, 32)},
                },
            },
        };
    } catch {
        // Do not echo exception text or untrusted filenames/URLs into notices.
        return {
            kind: 'rejected',
            reason: 'The attachment metadata, encryption, relation or size is invalid.',
        };
    }
}
