import {TransactionInbox, type InboxEvent} from './transaction-inbox.ts';

/** A decoder may update native crypto state, but must not send bridge messages remotely. */
export type TransactionDecoder = (
    body: unknown,
    emit: (event: InboxEvent) => Promise<void>,
) => Promise<void>;

/** Serializes crypto transaction application and commits its resulting inbox events atomically. */
export class TransactionWorker {
    private readonly inbox: TransactionInbox;
    private readonly decode: TransactionDecoder;
    private running?: Promise<number>;

    public constructor(inbox: TransactionInbox, decode: TransactionDecoder) {
        this.inbox = inbox;
        this.decode = decode;
    }

    public drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit <= 0 || limit > 1000)
            throw new Error('Invalid transaction batch limit');
        if (this.running) return this.running;
        this.running = this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }

    private async process(limit: number): Promise<number> {
        let completed = 0;
        let failed = false;
        for (const transaction of this.inbox.pendingTransactions(limit)) {
            this.inbox.recordAttempt(transaction.id);
            const events: InboxEvent[] = [];
            try {
                await this.decode(JSON.parse(transaction.body), async (event) => {
                    events.push(event);
                });
                this.inbox.complete(transaction.id, events);
                completed++;
            } catch {
                // A later transaction may carry the key that this one needs. Keep advancing.
                failed = true;
            }
        }
        if (failed) throw new Error('One or more transactions remain pending');
        return completed;
    }
}
