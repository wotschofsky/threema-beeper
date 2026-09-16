import type {InboxEvent, TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';
import type {ReactionTarget} from './reaction-target.ts';

/** Matrix redactions are authenticated control events, normally sent outside Megolm. */
export function resolveReactionWithdrawal(
    event: InboxEvent,
    options: {
        profile: string;
        owner: string;
        portals: Pick<PortalStore, 'portalForRoom'>;
        outbox: Pick<OutboxStore, 'reactions' | 'rejection'>;
        inbox: Pick<TransactionInbox, 'event'>;
    },
): ReactionTarget {
    if (
        event.type !== 'm.room.redaction' ||
        event.sender !== options.owner ||
        event.state_key !== undefined
    )
        return {kind: 'ignore'};
    const portal = options.portals.portalForRoom(event.room_id);
    if (!portal || portal.profile !== options.profile) return {kind: 'ignore'};
    const prior = options.outbox.rejection(options.profile, event.event_id);
    if (prior) return {kind: 'rejected', reason: prior.reason};
    const target = event.redacts ?? event.content.redacts;
    if (
        typeof target !== 'string' ||
        !/^\$[^\s]{1,1024}$/.test(target) ||
        (event.redacts !== undefined &&
            event.content.redacts !== undefined &&
            event.redacts !== event.content.redacts)
    )
        return {kind: 'rejected', reason: 'The reaction withdrawal target is invalid.'};
    const original = options.outbox.reactions.get(options.profile, target)?.operation;
    if (!original) {
        const source = options.inbox.event(target);
        if (source?.type !== 'm.reaction') return {kind: 'ignore'}; // A message deletion belongs to another consumer.
        if (source.sender !== options.owner || source.room_id !== event.room_id)
            return {kind: 'rejected', reason: 'Only your own bridged reaction can be withdrawn.'};
        if (options.outbox.rejection(options.profile, target))
            return {kind: 'rejected', reason: 'The original reaction was not sent to Threema.'};
        return {kind: 'pending'};
    }
    if (
        original.action !== 'apply' ||
        original.owner !== options.owner ||
        original.room !== event.room_id ||
        original.chat !== portal.chat
    )
        return {
            kind: 'rejected',
            reason: 'Only your own reaction in this conversation can be withdrawn.',
        };
    return {
        kind: 'resolved',
        chat: original.chat,
        messages: [...original.messages],
        emoji: original.emoji,
        target,
    };
}
