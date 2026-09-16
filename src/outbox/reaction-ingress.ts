import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';
import {resolveReactionTarget} from './reaction-target.ts';
import {resolveReactionWithdrawal} from './reaction-withdrawal.ts';
import {sourceOrderPermits} from './source-order.ts';

/** Commit immutable targets before consuming source events; remote calls belong to dispatch. */
export class ReactionIngress {
    private readonly options: {
        profile: string;
        owner: string;
        inbox: TransactionInbox;
        outbox: OutboxStore;
        portals: PortalStore;
    };
    private cursor = 0;
    constructor(options: ReactionIngress['options']) {
        this.options = options;
    }
    drain(limit = 100): number {
        const {inbox, outbox, profile, owner, portals} = this.options;
        let page = inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = inbox.pendingDeliveryPage(limit);
        }
        let completed = 0;
        for (const {sequence, event, transactionId} of page) {
            this.cursor = sequence;
            if (
                !transactionId ||
                !['m.reaction', 'm.room.redaction'].includes(event.type) ||
                event.state_key !== undefined ||
                event.sender !== owner ||
                portals.portalForRoom(event.room_id)?.profile !== profile
            )
                continue;
            const saved = outbox.reactions.get(profile, event.event_id);
            if (saved) {
                if (saved.operation.owner !== owner || saved.operation.room !== event.room_id)
                    throw new Error('Reaction source conflict');
                inbox.acknowledgeEvent(event.event_id);
                completed++;
                continue;
            }
            const result = !sourceOrderPermits(inbox, outbox, profile, event.event_id, 'ingress')
                ? {kind: 'pending' as const}
                : event.type === 'm.room.redaction'
                  ? resolveReactionWithdrawal(event, this.options)
                  : resolveReactionTarget(event, {
                        ...this.options,
                        pendingTarget: (id, room) => {
                            const target = inbox.event(id);
                            return (
                                target?.room_id === room &&
                                target.sender === owner &&
                                target.encrypted === true &&
                                target.state_key === undefined &&
                                target.type === 'm.room.message' &&
                                target.content.msgtype === 'm.text' &&
                                inbox.eventPrecedes(id, event.event_id) &&
                                !outbox.rejection(profile, id)
                            );
                        },
                    });
            if (result.kind === 'ignore' || result.kind === 'pending') continue;
            if (result.kind === 'rejected') {
                outbox.rejectEvent(profile, event.event_id, event.room_id, result.reason);
                // The notice worker owns rejection acknowledgement after an encrypted reply.
                continue;
            }
            outbox.reactions.prepare({
                profile,
                event: event.event_id,
                room: event.room_id,
                owner,
                chat: result.chat,
                target: result.target,
                emoji: result.emoji,
                messages: result.messages,
                action: event.type === 'm.room.redaction' ? 'withdraw' : 'apply',
            });
            inbox.acknowledgeEvent(event.event_id);
            completed++;
        }
        outbox.reactions.reorderPrepared((event) => inbox.sourcePosition(event));
        return completed;
    }
}
