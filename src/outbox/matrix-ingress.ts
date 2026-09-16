import type {TransactionInbox, InboxEvent} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';
import {splitReplyText, unavailableReplyText} from './reply-text.ts';
import {createRequestId} from './request-id.ts';
import {sourceOrderPermits} from './source-order.ts';
import {resolveReplyTarget} from './reply-target.ts';

/** Queue only verified decrypted owner text in an already-owned portal. Performs no remote sends. */
export class MatrixOutboxIngress {
    private cursor = 0;
    private readonly inbox: TransactionInbox;
    private readonly outbox: OutboxStore;
    private readonly portals: PortalStore;
    private readonly owner: string;
    private readonly profile: string;
    constructor(options: {
        inbox: TransactionInbox;
        outbox: OutboxStore;
        portals: PortalStore;
        owner: string;
        profile: string;
    }) {
        if (
            !/^@[\s\S]+:[\s\S]+$/.test(options.owner) ||
            !/^[A-Z0-9*][A-Z0-9]{7}$/.test(options.profile)
        )
            throw new Error('Invalid outbound owner configuration');
        this.inbox = options.inbox;
        this.outbox = options.outbox;
        this.portals = options.portals;
        this.owner = options.owner;
        this.profile = options.profile;
    }
    drain(limit = 100): number {
        let completed = 0,
            failed = false;
        let page = this.inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor !== 0) {
            this.cursor = 0;
            page = this.inbox.pendingDeliveryPage(limit);
        }
        for (const {sequence, event, transactionId} of page) {
            this.cursor = sequence;
            // Leave state events for their dedicated consumer; text ingestion cannot acknowledge them.
            if (event.state_key !== undefined) continue;
            // Shared inbox: other consumers own management rooms and unknown-room events.
            // Never acknowledge an event merely because this dispatcher cannot route it.
            if (this.portals.portalForRoom(event.room_id)?.profile !== this.profile) continue;
            try {
                this.queue(event, transactionId);
                // A crash here replays prepare; profile/event dedup preserves the original UUID.
                this.inbox.acknowledgeEvent(event.event_id);
                completed++;
            } catch {
                failed = true;
            }
        }
        this.outbox.reorderPrepared((event) => this.inbox.sourcePosition(event));
        if (failed) throw new Error('One or more outbound Matrix events remain pending');
        return completed;
    }
    private queue(event: InboxEvent, transactionId: string | null): void {
        if (event.sender !== this.owner) return;
        const portal = this.portals.portalForRoom(event.room_id);
        if (!portal || portal.profile !== this.profile) return;
        if (event.encrypted !== true) throw new Error('OUTBOUND_ENCRYPTION_REQUIRED');
        if (!transactionId) throw new Error('OUTBOUND_TRANSACTION_ID_MISSING');
        if (!sourceOrderPermits(this.inbox, this.outbox, this.profile, event.event_id, 'ingress'))
            throw new Error('OUTBOUND_PREDECESSOR_PENDING');
        if (this.outbox.rejection(this.profile, event.event_id))
            throw new Error('OUTBOUND_EVENT_REJECTED');
        if (event.type !== 'm.room.message' || event.content.msgtype !== 'm.text')
            throw new Error('UNSUPPORTED');
        const body = event.content.body;
        if (typeof body !== 'string' || !body || Buffer.byteLength(body) > 1024 * 1024)
            throw new Error('INVALID_ARGUMENT');
        // The inbox event is immutable. A retry after prepare must preserve the original
        // reply projection even if the target becomes available before acknowledgement.
        const saved = this.outbox.forEvent(this.profile, event.event_id);
        if (saved) {
            if (
                saved.request.roomId !== event.room_id ||
                saved.request.sender !== event.sender ||
                saved.request.chatId !== portal.chat
            )
                throw new Error('Outbound source conflict');
            return;
        }
        let text = body;
        let replyTo: string | undefined;
        const relation = event.content['m.relates_to'];
        if (relation !== undefined) {
            if (!relation || typeof relation !== 'object') throw new Error('INVALID_ARGUMENT');
            const value = relation as Record<string, unknown>;
            if (value.rel_type !== undefined) throw new Error('UNSUPPORTED');
            const reply = value['m.in_reply_to'] as {event_id?: unknown} | undefined;
            if (typeof reply?.event_id !== 'string') throw new Error('INVALID_ARGUMENT');
            replyTo = resolveReplyTarget({
                profile: this.profile,
                owner: this.owner,
                room: event.room_id,
                chat: portal.chat,
                event: event.event_id,
                target: reply.event_id,
                inbox: this.inbox,
                portals: this.portals,
                outbox: this.outbox,
            });
            const replyText = splitReplyText(text);
            if (!replyText.body) throw new Error('INVALID_ARGUMENT');
            text = replyTo ? replyText.body : unavailableReplyText(replyText.body, replyText.quote);
        }
        // This pinned native sender creates one text fragment and enforces 6000 UTF-8 bytes.
        // Check the final reply projection, not the potentially larger Matrix quote fallback.
        if (Buffer.byteLength(text) > 6000) {
            this.outbox.rejectEvent(
                this.profile,
                event.event_id,
                event.room_id,
                'The text exceeds the Threema limit of 6000 UTF-8 bytes. Shorten it and send again.',
            );
            throw new Error('OUTBOUND_TEXT_LIMIT');
        }
        this.outbox.prepare({
            requestId: createRequestId(),
            profile: this.profile,
            transactionId,
            eventId: event.event_id,
            roomId: event.room_id,
            sender: event.sender,
            chatId: portal.chat,
            text,
            ...(replyTo === undefined ? {} : {replyTo}),
        });
    }
}
