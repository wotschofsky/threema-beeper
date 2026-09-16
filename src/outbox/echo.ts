import {hasOutboundDeliveryEvidence} from './delivery-evidence.ts';
import {createHash} from 'node:crypto';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import type {OutboxStore} from './store.ts';

/** Persist the Matrix association before marking the corresponding outbox part observed. */
export function reconcileOutboundEcho(
    outbox: OutboxStore,
    portals: PortalStore,
    profile: string,
    owner: string,
    message: NormalizedNodeMessage,
    allowOwnerTextProjection = false,
    allowOwnerMediaProjection = false,
): boolean {
    const record = outbox.forMessage(profile, message.messageId);
    if (!record)
        return reconcileMediaEcho(
            outbox,
            portals,
            profile,
            owner,
            message,
            allowOwnerMediaProjection,
        );
    if (
        message.direction !== 'outbound' ||
        message.senderIdentity !== profile ||
        record.request.profile !== profile ||
        record.request.sender !== owner ||
        record.request.chatId !== message.chatId
    )
        throw new Error('Outbound echo identity conflict');
    // Text currently generates a single message. Other fragment projections need their own mapping.
    if (record.ids.length !== 1) throw new Error('Multipart echo projection is not implemented');
    const deleted = message.content.type === 'deleted';
    let projectOwnerText = false;
    if (!deleted) {
        if (message.content.type !== 'text' || message.replyToMessageId !== record.request.replyTo)
            throw new Error('Outbound echo mutation requires an owner event handler');
        const knownEdit = outbox.mutations.matchesEditEcho(
            profile,
            owner,
            record.request.roomId,
            message.chatId,
            record.request.eventId,
            message.messageId,
            message.content.text,
        );
        const changed = message.content.text !== record.request.text;
        const mapped = portals.messageMapping(profile, message.chatId, message.messageId);
        // After a phone projection, compare against the current projection digest. A match
        // to historical Beeper text alone cannot establish that Matrix already shows it.
        projectOwnerText =
            allowOwnerTextProjection &&
            ((changed && !knownEdit) || (mapped !== undefined && mapped.latest !== mapped.root));
        if (changed && !knownEdit && !projectOwnerText)
            throw new Error('Outbound echo mutation requires an owner event handler');
    }
    portals.bindOwnerEcho({
        profile,
        chat: message.chatId,
        message: message.messageId,
        room: record.request.roomId,
        sender: owner,
        root: record.request.eventId,
        latest: record.request.eventId,
        digest: createHash('sha256')
            .update(JSON.stringify(['outbox', record.request.requestId]))
            .digest('hex'),
    });
    if (hasOutboundDeliveryEvidence(message))
        outbox.observe(profile, message.chatId, message.messageId);
    return !projectOwnerText;
}

function reconcileMediaEcho(
    outbox: OutboxStore,
    portals: PortalStore,
    profile: string,
    owner: string,
    message: NormalizedNodeMessage,
    allowOwnerProjection: boolean,
): boolean {
    const record = outbox.media.forMessage(profile, message.messageId);
    if (!record) return false;
    const request = record.request,
        media = request.media;
    if (
        message.direction !== 'outbound' ||
        message.senderIdentity !== profile ||
        request.profile !== profile ||
        request.owner !== owner ||
        media.chat !== message.chatId
    )
        throw new Error('Media echo identity conflict');
    if (record.ids.length !== 1) throw new Error('Multipart media echo mapping is not implemented');
    const content = message.content;
    let projectOwnerCaption = false;
    const captionMatches = (expected: string | undefined) => {
        const caption = 'caption' in content ? (content.caption ?? '') : '';
        const editable = ['file', 'image', 'video'].includes(content.type);
        const knownEdit =
            editable &&
            outbox.mutations.matchesEditEcho(
                profile,
                owner,
                request.room,
                message.chatId,
                request.event,
                message.messageId,
                caption,
            );
        const mapped = portals.messageMapping(profile, message.chatId, message.messageId);
        projectOwnerCaption =
            allowOwnerProjection &&
            editable &&
            ((caption !== (expected ?? '') && !knownEdit) ||
                (mapped !== undefined && mapped.latest !== mapped.root));
        return caption === (expected ?? '') || knownEdit || projectOwnerCaption;
    };
    if (content.type !== 'deleted' && media.kind === 'm.image') {
        const prepared = outbox.media.imageProjection(profile, request.event);
        if (
            !prepared ||
            message.replyToMessageId !== undefined ||
            content.type !== 'image' ||
            content.fileName !== prepared.fileName ||
            content.mimeType !== prepared.mediaType ||
            content.byteSize !== prepared.bytes ||
            !captionMatches(prepared.caption) ||
            content.dimensions?.width !== prepared.width ||
            content.dimensions?.height !== prepared.height ||
            content.thumbnailMimeType !== prepared.thumbnailMediaType
        )
            throw new Error('Image echo differs from its canonical prepared projection');
    } else if (content.type !== 'deleted' && media.kind === 'm.video') {
        const prepared = outbox.media.videoProjection(profile, request.event);
        if (
            !prepared ||
            message.replyToMessageId !== undefined ||
            content.type !== prepared.kind ||
            content.fileName !== prepared.fileName ||
            content.mimeType !== prepared.mediaType ||
            content.byteSize !== prepared.bytes ||
            !captionMatches(prepared.caption) ||
            (prepared.kind === 'video' &&
                (content.durationSeconds !== prepared.durationSeconds ||
                    content.dimensions?.width !== prepared.width ||
                    content.dimensions?.height !== prepared.height ||
                    content.thumbnailMimeType !== prepared.thumbnailMediaType))
        )
            throw new Error('Video echo differs from its canonical prepared projection');
    } else if (content.type !== 'deleted' && media.kind === 'm.audio') {
        const prepared = outbox.media.audioProjection(profile, request.event);
        if (
            !prepared ||
            message.replyToMessageId !== undefined ||
            content.type !== prepared.kind ||
            content.fileName !== prepared.fileName ||
            content.mimeType !== prepared.mediaType ||
            content.byteSize !== prepared.bytes ||
            (prepared.kind === 'audio' && content.durationSeconds !== prepared.durationSeconds) ||
            !captionMatches(prepared.caption)
        )
            throw new Error('Audio echo differs from its canonical prepared projection');
    } else if (
        content.type !== 'deleted' &&
        (media.kind !== 'm.file' ||
            message.replyToMessageId !== undefined ||
            content.type !== 'file' ||
            content.fileName !== media.filename ||
            content.mimeType !== media.mimeType ||
            !captionMatches(media.caption) ||
            (media.bytes !== undefined && content.byteSize !== media.bytes))
    )
        throw new Error('Media echo mutation requires an owner event handler');
    portals.bindOwnerEcho({
        profile,
        chat: message.chatId,
        message: message.messageId,
        room: request.room,
        sender: owner,
        root: request.event,
        latest: request.event,
        digest: createHash('sha256')
            .update(JSON.stringify(['media-outbox', request.id]))
            .digest('hex'),
    });
    if (hasOutboundDeliveryEvidence(message))
        outbox.media.observe(profile, message.chatId, message.messageId);
    return !projectOwnerCaption;
}
