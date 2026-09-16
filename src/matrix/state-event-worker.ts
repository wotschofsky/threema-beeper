import type {TransactionInbox, InboxEvent} from './transaction-inbox.ts';

/** Dedicated state consumer. The handler returns true only after all implemented effects finish. */
export class StateEventWorker {
    private readonly inbox: TransactionInbox;
    private readonly handle: (event: InboxEvent) => Promise<boolean>;
    private cursor = 0;
    private running?: Promise<number>;
    constructor(inbox: TransactionInbox, handle: (event: InboxEvent) => Promise<boolean>) {
        this.inbox = inbox;
        this.handle = handle;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid state batch size'));
        if (this.running) return this.running;
        this.running = this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        let page = this.inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = this.inbox.pendingDeliveryPage(limit);
        }
        let completed = 0,
            failed = false;
        for (const {sequence, event, transactionId} of page) {
            this.cursor = sequence;
            if (typeof event.state_key !== 'string' || !transactionId) continue;
            try {
                if (await this.handle(event)) {
                    this.inbox.acknowledgeEvent(event.event_id);
                    completed++;
                }
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('State events remain pending');
        return completed;
    }
}
