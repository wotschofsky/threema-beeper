import {createHash} from 'node:crypto';
import type {InboxEvent, TransactionInbox} from './transaction-inbox.ts';
import type {PortalStore} from './portal-store.ts';
import type {MessageJournal} from '../threema/message-journal.ts';
import type {ReadCommand} from '../threema/read-command.ts';

const type = 'com.threema.owner_read';
/** Called only on the authenticated appservice transaction, before atomic inbox completion. */
export function ownerReadEvents(body: unknown, owner: string): InboxEvent[] {
    if (!body || typeof body !== 'object') return [];
    const transaction = body as Record<string, unknown>;
    const rows = transaction.ephemeral ?? transaction['de.sorunome.msc2409.ephemeral'];
    if (!Array.isArray(rows) || rows.length > 10000) return [];
    const result: InboxEvent[] = [];
    for (const row of rows) {
        if (
            row?.type !== 'm.receipt' ||
            typeof row.room_id !== 'string' ||
            !/^![^\s]{1,1024}$/.test(row.room_id) ||
            !row.content ||
            typeof row.content !== 'object' ||
            Array.isArray(row.content)
        )
            continue;
        for (const [target, value] of Object.entries(row.content)) {
            if (!/^\$[^\s]{1,1024}$/.test(target) || !value || typeof value !== 'object') continue;
            // Private receipts are local read markers, not consent to notify the remote contact.
            const receipt = (value as any)['m.read']?.[owner];
            if (
                !receipt ||
                typeof receipt !== 'object' ||
                Array.isArray(receipt) ||
                (receipt.thread_id !== undefined && receipt.thread_id !== 'main')
            )
                continue;
            const id = createHash('sha256')
                .update(JSON.stringify([owner, row.room_id, target]))
                .digest('hex');
            result.push({
                event_id: '$read_' + id,
                sender: owner,
                room_id: row.room_id,
                type,
                content: {target},
            });
        }
    }
    return result;
}

/** Read operations are idempotent upstream; failed calls remain durable for reconnect recovery. */
export class OwnerReadReceipts {
    private cursor = 0;
    private readonly options: {
        profile: string;
        owner: string;
        inbox: TransactionInbox;
        portals: PortalStore;
        journal: MessageJournal;
        ready: () => boolean;
        authorize: (room: string, chat: string) => Promise<void>;
        markRead: (request: ReadCommand) => Promise<void>;
    };
    constructor(options: OwnerReadReceipts['options']) {
        this.options = options;
    }
    async drain(limit = 100): Promise<number> {
        const o = this.options;
        if (!o.ready()) return 0;
        let page = o.inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = o.inbox.pendingDeliveryPage(limit);
        }
        let done = 0,
            failed = false;
        for (const {sequence, event} of page) {
            this.cursor = sequence;
            if (event.type !== type || event.sender !== o.owner) continue;
            const portal = o.portals.portalForRoom(event.room_id);
            if (portal?.profile !== o.profile) {
                o.inbox.acknowledgeEvent(event.event_id);
                continue;
            }
            try {
                if (typeof event.content.target !== 'string') throw Error('Invalid read target');
                const id =
                    o.portals.messageForEvent(o.profile, portal.chat, event.content.target) ??
                    o.portals.readTarget(o.profile, portal.chat, event.content.target);
                if (!id) {
                    // Events such as status notices and reactions do not represent native messages.
                    const target = o.inbox.event(event.content.target);
                    if (
                        o.portals.ownNonMessageEvent(event.room_id, event.content.target) ||
                        (target &&
                            (target.type !== 'm.room.message' ||
                                target.content.msgtype === 'm.notice'))
                    )
                        o.inbox.acknowledgeEvent(event.event_id);
                    continue;
                }
                const message = o.journal.message(portal.chat, id);
                if (!message) continue;
                const old = o.portals.receiptPosition(o.profile, portal.chat, o.owner);
                if (!old || BigInt(old.ordinal) < message.ordinal) {
                    await o.authorize(event.room_id, portal.chat);
                    if (!o.ready()) break;
                    await o.markRead({profile: o.profile, chatId: portal.chat, messageId: id});
                    o.portals.saveReceiptPosition(
                        o.profile,
                        portal.chat,
                        o.owner,
                        message.ordinal,
                        id,
                    );
                }
                o.inbox.acknowledgeEvent(event.event_id);
                done++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw Error('Read receipt synchronization requires retry');
        return done;
    }
}
