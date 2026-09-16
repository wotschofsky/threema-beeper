import type {InboxEvent, TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';

export type MutationTarget =
    | {kind: 'ignore'}
    | {kind: 'pending'}
    | {kind: 'rejected'; reason: string}
    | ({kind: 'resolved'; chat: string; target: string; messages: string[]} & (
          | {action: 'delete'}
          | {action: 'edit'; replacement: Record<string, unknown>}
      ));

/** Resolve ownership and all remote parts; replacement normalization and dispatch happen later. */
export function resolveMutationTarget(
    event: InboxEvent,
    options: {
        profile: string;
        owner: string;
        portals: Pick<PortalStore, 'portalForRoom' | 'messageForEvent' | 'messageMapping'>;
        outbox: Pick<OutboxStore, 'forEvent' | 'rejection' | 'media' | 'reactions'>;
        inbox: Pick<TransactionInbox, 'event'>;
        pendingTarget?: (event: string, room: string) => boolean;
    },
): MutationTarget {
    if (event.sender !== options.owner || event.state_key !== undefined) return {kind: 'ignore'};
    const relation = event.content['m.relates_to'];
    const edit =
        event.type === 'm.room.message' &&
        relation &&
        typeof relation === 'object' &&
        !Array.isArray(relation) &&
        (relation as Record<string, unknown>).rel_type === 'm.replace';
    if (!edit && event.type !== 'm.room.redaction') return {kind: 'ignore'};
    const portal = options.portals.portalForRoom(event.room_id);
    if (!portal || portal.profile !== options.profile) return {kind: 'ignore'};
    const reject = (reason: string): MutationTarget => ({kind: 'rejected', reason});
    const target = edit
        ? (relation as Record<string, unknown>).event_id
        : (event.redacts ?? event.content.redacts);
    if (
        typeof target !== 'string' ||
        !/^\$[^\s]{1,1024}$/.test(target) ||
        target === event.event_id ||
        (!edit &&
            event.redacts !== undefined &&
            event.content.redacts !== undefined &&
            event.redacts !== event.content.redacts)
    )
        return reject('The message change target is invalid.');
    // Reaction redactions belong exclusively to the reaction consumer, even before it has sent.
    if (
        !edit &&
        (options.outbox.reactions.get(options.profile, target) ||
            options.inbox.event(target)?.type === 'm.reaction')
    )
        return {kind: 'ignore'};
    const targetEvent = options.inbox.event(target);
    const targetRelation = targetEvent?.content['m.relates_to'];
    if (
        targetRelation &&
        typeof targetRelation === 'object' &&
        !Array.isArray(targetRelation) &&
        (targetRelation as Record<string, unknown>).rel_type === 'm.replace'
    )
        return reject('Change the original message rather than an earlier edit event.');
    const prior = options.outbox.rejection(options.profile, event.event_id);
    if (prior) return reject(prior.reason);
    if (edit && event.encrypted !== true) return reject('An encrypted message edit is required.');
    const replacement = event.content['m.new_content'];
    if (edit && (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)))
        return reject('The replacement message content is invalid.');
    const resolved = (messages: string[]): MutationTarget => ({
        kind: 'resolved',
        chat: portal.chat,
        target,
        messages: [...messages],
        ...(edit
            ? {action: 'edit', replacement: structuredClone(replacement as Record<string, unknown>)}
            : {action: 'delete'}),
    });
    if (options.outbox.rejection(options.profile, target))
        return reject('The original message was not sent to Threema.');
    const text = options.outbox.forEvent(options.profile, target);
    if (text) {
        if (
            text.request.roomId !== event.room_id ||
            text.request.chatId !== portal.chat ||
            text.request.sender !== options.owner
        )
            return reject('Only your own message in this conversation can be changed.');
        if (!['SENT', 'ACKED'].includes(text.state) || text.ids.length === 0)
            return {kind: 'pending'};
        return resolved(text.ids);
    }
    const media = options.outbox.media.get(options.profile, target);
    if (media) {
        if (
            media.request.room !== event.room_id ||
            media.request.media.chat !== portal.chat ||
            media.request.owner !== options.owner
        )
            return reject('Only your own message in this conversation can be changed.');
        if (media.state !== 'SENT' || media.ids.length === 0) return {kind: 'pending'};
        return resolved(media.ids);
    }
    const message = options.portals.messageForEvent(options.profile, portal.chat, target);
    if (!message)
        return options.pendingTarget?.(target, event.room_id)
            ? {kind: 'pending'}
            : reject('The original message is not available in this linked profile.');
    const mapping = options.portals.messageMapping(options.profile, portal.chat, message);
    if (
        !mapping ||
        mapping.sender !== options.owner ||
        mapping.room !== event.room_id ||
        mapping.profile !== options.profile ||
        mapping.chat !== portal.chat
    )
        return reject('Only your own message in this conversation can be changed.');
    if (target !== mapping.root)
        return reject('Change the original message rather than an earlier edit event.');
    return resolved([message]);
}
