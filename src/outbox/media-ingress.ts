import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import {resolveOutboundMedia} from '../media/outbound-event.ts';
import type {OutboxStore} from './store.ts';
import {createRequestId} from './request-id.ts';
import {sourceOrderPermits} from './source-order.ts';

/** Shared by ingress and notices so their supported-event decisions cannot diverge. */
export function resolveSendableFile(
    event: Parameters<typeof resolveOutboundMedia>[0],
    options: Parameters<typeof resolveOutboundMedia>[1] & {
        attachmentReplies?: boolean;
        imagesEnabled?: boolean;
        audioEnabled?: boolean;
        videosEnabled?: boolean;
    },
): ReturnType<typeof resolveOutboundMedia> {
    const result = resolveOutboundMedia(event, options);
    if (result.kind !== 'resolved') return result;
    const image =
        options.imagesEnabled === true &&
        result.media.kind === 'm.image' &&
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(
            result.media.mimeType,
        );
    const audio =
        options.audioEnabled === true &&
        result.media.kind === 'm.audio' &&
        result.media.mimeType.startsWith('audio/');
    const video =
        options.videosEnabled === true &&
        result.media.kind === 'm.video' &&
        result.media.mimeType.startsWith('video/');
    if (
        (!image && !audio && !video && result.media.kind !== 'm.file') ||
        (result.media.replyTo !== undefined &&
            !(options.attachmentReplies && ['m.file', 'm.image'].includes(result.media.kind)))
    )
        return {kind: 'rejected', reason: 'This attachment type or reply cannot be sent yet.'};
    return result;
}

/** Durably classifies files before acknowledging; performs no network or file downloads. */
export class MediaIngress {
    private cursor = 0;
    private readonly options: Parameters<typeof resolveOutboundMedia>[1] & {
        inbox: TransactionInbox;
        outbox: OutboxStore;
        attachmentReplies?: boolean;
        imagesEnabled?: boolean;
        audioEnabled?: boolean;
        videosEnabled?: boolean;
    };
    constructor(options: MediaIngress['options']) {
        this.options = options;
    }

    drain(limit = 100): number {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid media ingress batch size');
        const {inbox, outbox, profile, owner} = this.options;
        let page = inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = inbox.pendingDeliveryPage(limit);
        }
        let completed = 0,
            failed = false;
        for (const {sequence, event, transactionId} of page) {
            this.cursor = sequence;
            const result = resolveSendableFile(event, this.options);
            // Rejections belong to the durable notice consumer, not to acknowledgement here.
            if (result.kind !== 'resolved' || outbox.rejection(profile, event.event_id)) continue;
            try {
                if (
                    !transactionId ||
                    !sourceOrderPermits(inbox, outbox, profile, event.event_id, 'ingress')
                )
                    throw new Error('Media predecessor or transaction is unavailable');
                outbox.media.prepare({
                    id: createRequestId(),
                    profile,
                    owner,
                    event: event.event_id,
                    room: event.room_id,
                    transaction: transactionId,
                    media: result.media,
                });
                inbox.acknowledgeEvent(event.event_id);
                completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Outbound media events remain pending');
        return completed;
    }
}
