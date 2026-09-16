import {decodeMessage, encodeMessage} from '../threema/message-codec.ts';
import type {InboxEvent} from './transaction-inbox.ts';
import type {PortalStore} from './portal-store.ts';
import type {NormalizedNodeMessage} from '../threema/history.ts';

/** Reuse the owner's original encrypted attachment descriptor when projecting a caption edit. */
export function createOwnerMediaRenderer(options: {
    profile: string;
    owner: string;
    portals: PortalStore;
    original: (event: string, room: string) => Promise<InboxEvent | undefined>;
}) {
    return async (value: NormalizedNodeMessage): Promise<Record<string, unknown>> => {
        const message = decodeMessage(encodeMessage(value));
        if (
            message.direction !== 'outbound' ||
            message.senderIdentity !== options.profile ||
            !['file', 'image', 'video'].includes(message.content.type)
        )
            throw new Error('Unsupported owner media edit');
        const mapping = options.portals.messageMapping(
            options.profile,
            message.chatId,
            message.messageId,
        );
        if (
            !mapping ||
            mapping.sender !== options.owner ||
            options.portals.get(options.profile, message.chatId) !== mapping.room
        )
            throw new Error('Owner media mapping unavailable');
        const original = await options.original(mapping.root, mapping.room);
        const current = options.portals.messageMapping(
            options.profile,
            message.chatId,
            message.messageId,
        );
        if (
            !current ||
            current.root !== mapping.root ||
            current.room !== mapping.room ||
            current.sender !== options.owner ||
            options.portals.get(options.profile, message.chatId) !== mapping.room
        )
            throw new Error('Owner media mapping changed');
        if (
            !original ||
            original.event_id !== mapping.root ||
            original.room_id !== mapping.room ||
            original.sender !== options.owner ||
            original.encrypted !== true ||
            original.state_key !== undefined ||
            original.type !== 'm.room.message'
        )
            throw new Error('Verified owner media original unavailable');
        const content = structuredClone(original.content);
        if (
            !['m.file', 'm.image', 'm.video', 'm.audio'].includes(content.msgtype as string) ||
            !content.file ||
            typeof content.file !== 'object' ||
            Array.isArray(content.file) ||
            typeof content.body !== 'string' ||
            content['m.new_content'] !== undefined
        )
            throw new Error('Original event is not an encrypted attachment');
        const relation = content['m.relates_to'] as Record<string, unknown> | undefined;
        if (relation?.rel_type === 'm.replace')
            throw new Error('Owner media root is a replacement');
        const filename = content.filename ?? content.body;
        if (typeof filename !== 'string' || !filename)
            throw new Error('Owner media filename unavailable');
        const caption = 'caption' in message.content ? message.content.caption : undefined;
        content.filename = filename;
        content.body = caption || filename;
        delete content.format;
        delete content.formatted_body;
        return content;
    };
}
