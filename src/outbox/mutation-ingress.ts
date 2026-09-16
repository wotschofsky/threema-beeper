import type {InboxEvent, TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';
import {resolveMutationTarget} from './mutation-target.ts';
import {normalizeMutationContent} from './mutation-content.ts';
import {parseMutationCommand, type NodeMutationRequest} from '../threema/mutation-command.ts';
import {sourceOrderPermits} from './source-order.ts';
import {splitReplyText, unavailableReplyText} from './reply-text.ts';

/** Commit the complete edit/delete plan before acknowledging its Matrix source event. */
export class MutationIngress {
    private readonly options: {
        profile: string;
        owner: string;
        inbox: TransactionInbox;
        outbox: OutboxStore;
        portals: PortalStore;
        /** Return a verified decrypted event; transport failure must reject instead of returning stale content. */
        original: (event: string, room: string) => Promise<InboxEvent | undefined>;
    };
    private cursor = 0;
    private running?: Promise<number>;
    constructor(options: MutationIngress['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid mutation ingress batch'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        const {inbox, outbox, profile, owner, portals} = this.options;
        let page = inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = inbox.pendingDeliveryPage(limit);
        }
        let completed = 0,
            failed = false;
        for (const {sequence, event, transactionId} of page) {
            this.cursor = sequence;
            const portal = portals.portalForRoom(event.room_id);
            if (
                !transactionId ||
                event.sender !== owner ||
                event.state_key !== undefined ||
                portal?.profile !== profile
            )
                continue;
            try {
                const saved = outbox.mutations.get(profile, event.event_id);
                if (saved) {
                    if (
                        saved.operation.owner !== owner ||
                        saved.operation.room !== event.room_id ||
                        saved.operation.chat !== portal.chat
                    )
                        throw new Error('Mutation source conflict');
                    inbox.acknowledgeEvent(event.event_id);
                    completed++;
                    continue;
                }
                if (!sourceOrderPermits(inbox, outbox, profile, event.event_id, 'ingress'))
                    continue;
                const result = resolveMutationTarget(event, {
                    ...this.options,
                    pendingTarget: (id, room) => {
                        const previous = inbox.event(id);
                        return (
                            previous?.sender === owner &&
                            previous.room_id === room &&
                            previous.encrypted === true &&
                            previous.type === 'm.room.message' &&
                            inbox.eventPrecedes(id, event.event_id) &&
                            !outbox.rejection(profile, id)
                        );
                    },
                });
                if (result.kind === 'ignore' || result.kind === 'pending') continue;
                if (result.kind === 'rejected') {
                    outbox.rejectEvent(profile, event.event_id, event.room_id, result.reason);
                    continue;
                }
                let commands: NodeMutationRequest[];
                if (result.action === 'delete')
                    commands = result.messages.map((messageId) => ({
                        profile,
                        chatId: result.chat,
                        messageId,
                        action: 'delete',
                    }));
                else {
                    const original =
                        inbox.event(result.target) ??
                        (await this.options.original(result.target, event.room_id));
                    if (!original) continue;
                    if (
                        original.event_id !== result.target ||
                        original.room_id !== event.room_id ||
                        original.sender !== owner ||
                        original.type !== 'm.room.message' ||
                        original.state_key !== undefined ||
                        original.encrypted !== true
                    ) {
                        outbox.rejectEvent(
                            profile,
                            event.event_id,
                            event.room_id,
                            'The original encrypted message could not be verified.',
                        );
                        continue;
                    }
                    try {
                        const originalMedia = outbox.media.get(profile, result.target);
                        const audioFileFallback =
                            originalMedia?.request.media.kind === 'm.audio' &&
                            outbox.media.audioProjection(profile, result.target)?.kind === 'file';
                        let text = normalizeMutationContent(original.content, result.replacement, {
                            audioFileFallback,
                        });
                        const originalText = outbox.forEvent(profile, result.target);
                        if (
                            original.content.msgtype === 'm.text' &&
                            original.content['m.relates_to'] !== undefined &&
                            originalText &&
                            originalText.request.replyTo === undefined
                        ) {
                            text = unavailableReplyText(
                                text,
                                splitReplyText(String(result.replacement.body)).quote,
                            );
                        }
                        if (original.content.msgtype !== 'm.text' && result.messages.length !== 1)
                            throw new Error('Compound media edit');
                        commands = result.messages.map((messageId, part) =>
                            parseMutationCommand({
                                profile,
                                chatId: result.chat,
                                messageId,
                                ...(part === 0 ? {action: 'edit', text} : {action: 'delete'}),
                            }),
                        );
                    } catch {
                        outbox.rejectEvent(
                            profile,
                            event.event_id,
                            event.room_id,
                            'This replacement changes unsupported content or exceeds the Threema edit limit.',
                        );
                        continue;
                    }
                }
                // Async retrieval must not allow classification past a newly discovered predecessor.
                if (!sourceOrderPermits(inbox, outbox, profile, event.event_id, 'ingress'))
                    continue;
                outbox.mutations.prepare({
                    profile,
                    owner,
                    room: event.room_id,
                    chat: result.chat,
                    event: event.event_id,
                    target: result.target,
                    commands,
                });
                inbox.acknowledgeEvent(event.event_id);
                completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Mutation events remain pending');
        return completed;
    }
}
