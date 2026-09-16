import type {OutboxStore, TextRequest} from './store.ts';

export interface OutboundTextSender {
    /** Read-only authorization checks. Failure leaves the request PREPARED. */
    check?: (request: TextRequest) => Promise<void>;
    send(
        request: TextRequest,
        beforeSend: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]>;
}
/** A dispatch failure is uncertain unless the core can prove no side effect occurred. */
export class OutboxWorker {
    private readonly store: OutboxStore;
    private readonly sender: OutboundTextSender;
    private readonly ready: () => boolean;
    private readonly now: () => number;
    private readonly retryDelayMs: number;
    private active: Promise<boolean> | undefined;
    constructor(
        store: OutboxStore,
        sender: OutboundTextSender,
        ready: () => boolean,
        options: {now?: () => number; retryDelayMs?: number} = {},
    ) {
        this.now = options.now ?? Date.now;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
        if (
            !Number.isSafeInteger(this.retryDelayMs) ||
            this.retryDelayMs < 1 ||
            this.retryDelayMs > 300_000
        )
            throw new Error('Invalid outbox retry delay');
        this.store = store;
        this.sender = sender;
        this.ready = ready;
    }
    flushOne(): Promise<boolean> {
        return (this.active ??= this.perform().finally(() => {
            this.active = undefined;
        }));
    }
    private async perform(): Promise<boolean> {
        if (!this.ready()) return false;
        const candidate = this.store.nextPrepared(this.now());
        if (!candidate) return false;
        try {
            await this.sender.check?.(candidate.request);
        } catch (error) {
            const delay = Math.min(
                300_000,
                this.retryDelayMs * 2 ** Math.min(candidate.preflightFailures, 20),
            );
            this.store.deferPreflight(candidate.request.requestId, this.now() + delay);
            throw error;
        }
        if (!this.ready()) return false;
        const record = this.store.claim(candidate.request.requestId, this.now());
        if (!record) return false;
        try {
            const ids = await this.sender.send(record.request, async (allocated) => {
                this.store.recordIds(record.request.requestId, allocated);
            });
            this.store.sent(record.request.requestId, ids);
        } catch (error) {
            this.store.unknown(record.request.requestId);
            throw error;
        }
        return true;
    }
}
