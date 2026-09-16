import {normalizeReactionEmoji} from '../threema/reaction-emoji.ts';
import type {InboxEvent} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';

export type ReactionTarget =
    | {kind: 'ignore'}
    | {kind: 'pending'}
    | {kind: 'rejected'; reason: string}
    | {kind: 'resolved'; chat: string; messages: string[]; emoji: string; target: string};

/** Pure target selection: no acknowledgement, remote mutation or invented message IDs. */
export function resolveReactionTarget(
    event: InboxEvent,
    options: {
        profile: string;
        owner: string;
        portals: Pick<PortalStore, 'portalForRoom' | 'messageForEvent'>;
        outbox: Pick<OutboxStore, 'forEvent' | 'rejection' | 'media'>;
        pendingTarget?: (event: string, room: string) => boolean;
    },
): ReactionTarget {
    if (
        event.type !== 'm.reaction' ||
        event.state_key !== undefined ||
        event.sender !== options.owner
    )
        return {kind: 'ignore'};
    const portal = options.portals.portalForRoom(event.room_id);
    if (!portal || portal.profile !== options.profile) return {kind: 'ignore'};
    // Matrix clients also send authenticated, unencrypted reaction events in encrypted rooms.
    const prior = options.outbox.rejection(options.profile, event.event_id);
    if (prior) return {kind: 'rejected', reason: prior.reason};
    const relation = event.content['m.relates_to'];
    if (!relation || typeof relation !== 'object' || Array.isArray(relation))
        return {kind: 'rejected', reason: 'The reaction target is invalid.'};
    const row = relation as Record<string, unknown>;
    if (
        row.rel_type !== 'm.annotation' ||
        typeof row.event_id !== 'string' ||
        !/^\$[^\s]{1,1024}$/.test(row.event_id) ||
        typeof row.key !== 'string' ||
        !row.key ||
        Buffer.byteLength(row.key) > 128
    )
        return {kind: 'rejected', reason: 'The reaction target or emoji is invalid.'};
    const request = options.outbox.forEvent(options.profile, row.event_id);
    if (request) {
        if (
            request.request.chatId !== portal.chat ||
            request.request.roomId !== event.room_id ||
            request.request.sender !== options.owner
        )
            return {
                kind: 'rejected',
                reason: 'The reaction target belongs to another conversation.',
            };
        // Allocated IDs alone do not prove a send occurred. Wait for confirmation/echo.
        if (request.state !== 'SENT' && request.state !== 'ACKED') return {kind: 'pending'};
        if (!request.ids.length) return {kind: 'pending'};
        return {
            kind: 'resolved',
            chat: portal.chat,
            messages: [...request.ids],
            emoji: normalizeReactionEmoji(row.key),
            target: row.event_id,
        };
    }
    const media = options.outbox.media.get(options.profile, row.event_id);
    if (media) {
        if (
            media.request.media.chat !== portal.chat ||
            media.request.room !== event.room_id ||
            media.request.owner !== options.owner
        )
            return {
                kind: 'rejected',
                reason: 'The reaction target belongs to another conversation.',
            };
        // An allocated file ID may precede the actual model insertion or an uncertain send.
        // Do not fall through to an owner mapping committed before observation completed.
        if (media.state !== 'SENT' || !media.ids.length) return {kind: 'pending'};
        return {
            kind: 'resolved',
            chat: portal.chat,
            messages: [...media.ids],
            emoji: normalizeReactionEmoji(row.key),
            target: row.event_id,
        };
    }
    const message = options.portals.messageForEvent(options.profile, portal.chat, row.event_id);
    if (!message && options.pendingTarget?.(row.event_id, event.room_id)) return {kind: 'pending'};
    if (!message)
        return {
            kind: 'rejected',
            reason: 'The original message is not available in this linked profile.',
        };
    return {
        kind: 'resolved',
        chat: portal.chat,
        messages: [message],
        emoji: normalizeReactionEmoji(row.key),
        target: row.event_id,
    };
}
