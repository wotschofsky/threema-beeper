import type {BackendController} from '../threema/backend-controller.ts';
import type {MediaRequest} from './media-journal.ts';
import {resolveReplyTarget} from './reply-target.ts';
import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';

/** Threema attachments cannot quote: send one durable native text quote before the attachment. */
export function createMediaReply(options: {
    profile: string;
    owner: string;
    inbox: TransactionInbox;
    portals: PortalStore;
    outbox: OutboxStore;
    ready: () => boolean;
    send: BackendController['sendText'];
}) {
    return async (request: MediaRequest): Promise<void> => {
        if (!request.media.replyTo) return;
        const journal = options.outbox.media;
        let saved = journal.reply(request.profile, request.event);
        if (!saved) {
            const target = resolveReplyTarget({
                ...options,
                room: request.room,
                chat: request.media.chat,
                event: request.event,
                target: request.media.replyTo,
            });
            if (!target) throw Error('Attachment reply original is unavailable');
            journal.prepareReply(
                request.profile,
                request.event,
                target,
                `Replying with ${request.media.kind === 'm.image' ? 'a photo' : 'a file'}: ${request.media.filename}`,
            );
            saved = journal.reply(request.profile, request.event)!;
        }
        if (saved.state === 'SENT') return;
        if (saved.state !== 'PREPARED') throw Error('Attachment quote delivery is uncertain');
        if (!options.ready()) throw Error('Attachment quote connection unavailable');
        journal.claimReply(request.profile, request.event);
        try {
            const ids = await options.send(
                {
                    profile: request.profile,
                    chatId: request.media.chat,
                    text: saved.text,
                    replyTo: saved.target,
                },
                async (ids) => journal.replyIds(request.profile, request.event, ids),
            );
            journal.replySent(request.profile, request.event, ids);
        } catch (error) {
            journal.replyUnknown(request.profile, request.event);
            throw error;
        }
    };
}
