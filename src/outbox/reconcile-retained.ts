import {setImmediate} from 'node:timers/promises';
import type {MessageJournal} from '../threema/message-journal.ts';
import type {OutboxStore} from './store.ts';
import {hasOutboundDeliveryEvidence} from './delivery-evidence.ts';

/** Reconcile committed evidence even when unchanged history produces no delivery event.
 * Only bridge-owned IDs are inspected; this neither sends nor publishes Matrix events. */
export async function reconcileRetainedConfirmations(
    profile: string,
    outbox: OutboxStore,
    journal: Pick<MessageJournal, 'message'>,
    signal: AbortSignal,
): Promise<void> {
    function confirmed(chat: string, id: string): boolean {
        const message = journal.message(chat, id);
        return (
            message !== undefined &&
            message.chatId === chat &&
            message.messageId === id &&
            message.senderIdentity === profile &&
            hasOutboundDeliveryEvidence(message)
        );
    }
    for (const kind of ['text', 'attachment'] as const) {
        let after = 0;
        do {
            signal.throwIfAborted();
            const page = outbox.recoveryPage(profile, kind, after, 100);
            for (const item of page.items) {
                signal.throwIfAborted();
                if (kind === 'text') {
                    const record = outbox.get(item.id);
                    if (record?.request.profile !== profile || record.request.chatId !== item.chat)
                        continue;
                    for (const id of record.ids)
                        if (confirmed(item.chat, id)) outbox.observe(profile, item.chat, id);
                } else {
                    const record = outbox.media.get(profile, item.event);
                    if (record?.request.media.chat !== item.chat) continue;
                    const quote = outbox.media.reply(profile, item.event);
                    for (const id of quote?.ids ?? [])
                        if (confirmed(item.chat, id))
                            outbox.media.observeReply(profile, item.chat, id, true);
                    for (const id of record.ids)
                        if (confirmed(item.chat, id)) outbox.media.observe(profile, item.chat, id);
                }
            }
            after = page.next;
            if (after) await setImmediate(undefined, {signal});
        } while (after);
    }
}
