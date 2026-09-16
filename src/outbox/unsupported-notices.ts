import {createHash} from 'node:crypto';
import type {InboxEvent, TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';
import {resolveReactionWithdrawal} from './reaction-withdrawal.ts';
import {resolveSendableFile} from './media-ingress.ts';
import {resolveMutationTarget} from './mutation-target.ts';

export function unsupportedReason(event: InboxEvent): string | undefined {
    if (event.type === 'm.reaction') return 'Sending reactions is not implemented yet.';
    if (event.type === 'm.room.redaction')
        return 'Deleting Threema messages is not implemented yet.';
    if (event.type.startsWith('m.call.'))
        return 'Calls are not supported in Beeper. Open Threema on your phone to call.';
    if (['m.poll.start', 'org.matrix.msc3381.poll.start'].includes(event.type))
        return 'Polls are not supported in Beeper. Open Threema on your phone to create a poll.';
    if (event.type !== 'm.room.message') return undefined;
    if (event.content.msgtype === 'm.location')
        return 'Location sharing is not supported in Beeper. Open Threema on your phone to share a location.';
    if (event.content.msgtype !== 'm.text')
        return 'This message type is not supported in Beeper. Open Threema on your phone to send it.';
    if (
        typeof event.content.body !== 'string' ||
        !event.content.body ||
        Buffer.byteLength(event.content.body) > 1024 * 1024
    )
        return 'The text is empty, invalid or exceeds the bridge limit.';
    const relation = event.content['m.relates_to'];
    if (relation !== undefined) {
        if (!relation || typeof relation !== 'object') return 'The message relation is invalid.';
        const value = relation as Record<string, unknown>;
        if (value.rel_type !== undefined)
            return 'Sending edits and threaded messages is not implemented yet.';
        const reply = value['m.in_reply_to'] as {event_id?: unknown} | undefined;
        if (typeof reply?.event_id !== 'string') return 'The reply reference is invalid.';
    }
    return undefined;
}

/** Failed notices retain the original durable event; successful sends precede acknowledgement. */
export class UnsupportedNoticeWorker {
    private cursor = 0;
    private running?: Promise<number>;
    private readonly options: {
        inbox: TransactionInbox;
        portals: PortalStore;
        outbox: OutboxStore;
        profile: string;
        owner: string;
        ready: () => boolean;
        reactionsEnabled?: boolean;
        /** Enable only when mutation ingress owns edit/delete classification. */
        mutationsEnabled?: boolean;
        /** Enable only together with media ingress and dispatch, using the same admission limit. */
        files?: {
            maximumBytes: number;
            attachmentReplies?: boolean;
            imagesEnabled?: boolean;
            audioEnabled?: boolean;
            videosEnabled?: boolean;
        };
        authorize: (room: string, chat: string) => Promise<void>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: UnsupportedNoticeWorker['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid notice batch size'));
        if (this.running) return this.running;
        this.running = this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        const {inbox, portals, profile, owner} = this.options;
        if (!this.options.ready()) return 0;
        let page = inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = inbox.pendingDeliveryPage(limit);
        }
        let completed = 0,
            failed = false;
        for (const {sequence, event, transactionId} of page) {
            this.cursor = sequence;
            if (
                event.state_key !== undefined ||
                event.sender !== owner ||
                (event.encrypted !== true &&
                    !['m.room.redaction', 'm.reaction', 'm.call.invite'].includes(event.type)) ||
                !transactionId
            )
                continue;
            const portal = portals.portalForRoom(event.room_id);
            if (!portal || portal.profile !== profile) continue;
            const rejected = this.options.outbox.rejection(profile, event.event_id);
            if (
                !rejected &&
                (this.options.outbox.mutations.get(profile, event.event_id) ||
                    (this.options.mutationsEnabled &&
                        resolveMutationTarget(event, this.options).kind !== 'ignore'))
            )
                continue;
            if (this.options.reactionsEnabled && !rejected) {
                if (
                    event.type === 'm.reaction' ||
                    this.options.outbox.reactions.get(profile, event.event_id)
                )
                    continue;
                if (
                    event.type === 'm.room.redaction' &&
                    resolveReactionWithdrawal(event, this.options).kind !== 'ignore'
                )
                    continue;
            }
            const file = this.options.files
                ? resolveSendableFile(event, {...this.options, ...this.options.files})
                : undefined;
            if (
                !rejected &&
                (this.options.outbox.media.get(profile, event.event_id) ||
                    file?.kind === 'resolved')
            )
                continue;
            const reason =
                rejected?.reason ??
                (file?.kind === 'rejected' ? file.reason : unsupportedReason(event));
            if (!reason) continue;
            try {
                await this.options.authorize(event.room_id, portal.chat);
                if (!this.options.ready()) break;
                this.options.outbox.rejectEvent(profile, event.event_id, event.room_id, reason);
                const id =
                    'unsupported_' +
                    createHash('sha256')
                        .update(JSON.stringify([profile, event.room_id, event.event_id]))
                        .digest('hex');
                await this.options.send(id, event.room_id, {
                    'msgtype': 'm.notice',
                    'body': 'This action was not sent to Threema. ' + reason,
                    'm.relates_to': {'m.in_reply_to': {event_id: event.event_id}},
                });
                inbox.acknowledgeEvent(event.event_id);
                completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Unsupported-action notices remain pending');
        return completed;
    }
}
