import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {OutboxStore} from './store.ts';

/** Classify in source order, then keep cross-kind effects behind unsettled predecessors. */
export function sourceOrderPermits(
    inbox: TransactionInbox,
    outbox: OutboxStore,
    profile: string,
    event: string,
    phase: 'ingress' | 'dispatch',
): boolean {
    return inbox.predecessorsPermit(event, (previous) => {
        if (
            previous.encrypted !== true &&
            !['m.room.redaction', 'm.reaction'].includes(previous.type)
        )
            return true;
        if (
            previous.state_key !== undefined ||
            !['m.room.message', 'm.reaction', 'm.room.redaction'].includes(previous.type)
        )
            return true;
        if (outbox.rejection(profile, previous.event_id)) return true;
        const mutation = outbox.mutations.get(profile, previous.event_id);
        if (mutation)
            return (
                phase === 'ingress' ||
                mutation.states.every((state) =>
                    ['APPLIED', 'REJECTED', 'CANCELLED'].includes(state),
                )
            );
        const media = outbox.media.get(profile, previous.event_id);
        if (media) return phase === 'ingress' || media.state === 'SENT';
        const text = outbox.forEvent(profile, previous.event_id);
        if (text) return phase === 'ingress' || ['SENT', 'ACKED'].includes(text.state);
        const reaction = outbox.reactions.get(profile, previous.event_id);
        if (reaction)
            return (
                phase === 'ingress' ||
                reaction.states.every((state) => state === 'SENT' || state === 'REJECTED')
            );
        return false;
    });
}
