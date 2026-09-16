import {setTimeout as delay} from 'node:timers/promises';
import type {MessageJournal} from '../threema/message-journal.ts';
import type {ProfileMetadata} from '../threema/metadata-codec.ts';
import type {NormalizedNodeMessage} from '../threema/history.ts';

/** Implementations must persist Matrix event mappings before resolving and use operation IDs on retry. */
export interface JournalSink {
    metadata(value: ProfileMetadata, operationId: string): Promise<void>;
    message(value: NormalizedNodeMessage, operationId: string): Promise<void>;
}
export class JournalDelivery {
    private readonly journal: MessageJournal;
    private readonly sink: JournalSink;
    private readonly ready: () => boolean;
    private readonly intervalMs: number;
    private draining?: Promise<number>;
    private running?: Promise<void>;
    private abort?: AbortController;
    private current: 'stopped' | 'waiting' | 'delivering' | 'retrying' = 'stopped';
    constructor(
        journal: MessageJournal,
        sink: JournalSink,
        ready: () => boolean,
        intervalMs = 1000,
    ) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000)
            throw new Error('Invalid delivery interval');
        this.journal = journal;
        this.sink = sink;
        this.ready = ready;
        this.intervalMs = intervalMs;
    }
    get status(): string {
        return this.current;
    }
    /** Concurrent callers share one drain; completion never implies remote exactly-once delivery. */
    flush(): Promise<number> {
        if (!this.draining)
            this.draining = this.drain().finally(() => {
                this.draining = undefined;
            });
        return this.draining;
    }
    start(): void {
        if (this.running) return;
        this.abort = new AbortController();
        this.running = this.run(this.abort.signal);
    }
    async stop(): Promise<void> {
        this.abort ??= new AbortController();
        this.abort.abort();
        await this.running;
        await this.draining?.catch(() => undefined);
        this.running = undefined;
        this.current = 'stopped';
    }
    private enabled(): boolean {
        return !this.abort?.signal.aborted && this.ready();
    }
    private async drain(): Promise<number> {
        if (!this.enabled()) return 0;
        const metadata = this.journal.metadata(true);
        if (metadata) {
            await this.sink.metadata(metadata, `threema_metadata_${metadata.epoch}`);
            this.journal.acknowledgeMetadata(metadata.epoch);
        }
        if (!this.enabled() || this.journal.metadata(true)) return 0;
        // An initial metadata snapshot must exist before any portal message is applied.
        if (!this.journal.metadata()) return 0;
        let delivered = 0;
        for (const row of this.journal.pending(100)) {
            if (!this.enabled() || this.journal.metadata(true)) break;
            const operationId = this.journal.changeOperationId(row.sequence);
            await this.sink.message(row.message, operationId);
            this.journal.acknowledge(row.sequence);
            delivered++;
        }
        return delivered;
    }
    private async run(signal: AbortSignal): Promise<void> {
        let failures = 0;
        try {
            while (!signal.aborted) {
                let waitMs = this.intervalMs;
                try {
                    this.current = this.enabled() ? 'delivering' : 'waiting';
                    await this.flush();
                    failures = 0;
                    this.current = 'waiting';
                } catch {
                    this.current = 'retrying';
                    waitMs = Math.min(60000, this.intervalMs * 2 ** Math.min(++failures, 6));
                }
                try {
                    await delay(waitMs, undefined, {signal});
                } catch {
                    /* Stop interrupts backoff. */
                }
            }
        } finally {
            this.current = 'stopped';
        }
    }
}
