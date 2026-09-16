import {createHash} from 'node:crypto';
import type {OutboxStore} from './store.ts';
import type {PortalStore} from '../matrix/portal-store.ts';

/** Reuses durable encrypted operation IDs, including after a lost response or restart. */
export class SendFailureNotices {
    private readonly cursor = {text: 0, attachment: 0};
    private kind: 'text' | 'attachment' = 'text';
    private readonly options: {
        profile: string;
        outbox: OutboxStore;
        portals: PortalStore;
        ready: () => boolean;
        authorize: (room: string, chat: string) => Promise<void>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: SendFailureNotices['options']) {
        this.options = options;
    }
    async drain(limit = 100): Promise<number> {
        let done = 0,
            failed = false;
        const o = this.options;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid notice batch size');
        if (!o.ready()) return 0;
        const kind = this.kind;
        const page = o.outbox.recoveryPage(o.profile, kind, this.cursor[kind], limit);
        this.cursor[kind] = page.next;
        this.kind = kind === 'text' ? 'attachment' : 'text';
        for (const item of page.items) {
            if (!o.ready()) break;
            const uncertain = item.state === 'OUTCOME_UNKNOWN';
            if (!uncertain && !(item.state === 'PREPARED' && item.failures >= 3)) continue;
            const id =
                'send_failure_' +
                createHash('sha256')
                    .update(JSON.stringify([o.profile, item.id, uncertain]))
                    .digest('hex');
            if (o.portals.operation(id)?.event) continue;
            try {
                await o.authorize(item.room, item.chat);
                if (!o.ready()) break;
                await o.send(id, item.room, {
                    'msgtype': 'm.notice',
                    'body': uncertain
                        ? 'Delivery of this message could not be confirmed. Check Threema on your phone before sending it again. The bridge will not resend it automatically, to avoid duplicates.'
                        : 'This message has not been sent to Threema yet. The bridge will retry automatically. If it keeps failing, check the bridge connection and recovery status; you can send it from Threema on your phone instead.',
                    'm.relates_to': {'m.in_reply_to': {event_id: item.event}},
                });
                done++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw Error('Delivery failure notices need retry');
        return done;
    }
}
