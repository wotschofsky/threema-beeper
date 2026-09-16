import {setTimeout as delay} from 'node:timers/promises';
import type {OutboxStore} from './store.ts';
import {OutboxWorker, type OutboundTextSender} from './worker.ts';

export type OutboundState = 'stopped' | 'processing' | 'waiting' | 'retrying';
/** One dispatcher per exclusively owned profile. Stores/backend remain owned by the service. */
export class OutboxDispatcher {
    private readonly store: OutboxStore;
    private readonly worker: OutboxWorker;
    private readonly ingress: {drain(limit: number): number};
    private readonly intervalMs: number;
    private readonly batchSize: number;
    private readonly onState: (state: OutboundState) => void;
    private abort?: AbortController;
    private task?: Promise<void>;
    private state: OutboundState = 'stopped';
    constructor(options: {
        store: OutboxStore;
        sender: OutboundTextSender;
        ingress: {drain(limit: number): number};
        ready: () => boolean;
        intervalMs?: number;
        batchSize?: number;
        onState?: (state: OutboundState) => void;
    }) {
        this.intervalMs = options.intervalMs ?? 1000;
        this.batchSize = options.batchSize ?? 100;
        if (
            !Number.isSafeInteger(this.intervalMs) ||
            this.intervalMs < 10 ||
            this.intervalMs > 60_000 ||
            !Number.isSafeInteger(this.batchSize) ||
            this.batchSize < 1 ||
            this.batchSize > 1000
        )
            throw new Error('Invalid outbound dispatcher configuration');
        this.store = options.store;
        this.ingress = options.ingress;
        this.onState = options.onState ?? (() => {});
        this.worker = new OutboxWorker(
            options.store,
            options.sender,
            () => this.abort !== undefined && !this.abort.signal.aborted && options.ready(),
        );
    }
    get status(): OutboundState {
        return this.state;
    }
    start(): void {
        if (this.task) return;
        this.store.recoverInterrupted();
        this.abort = new AbortController();
        this.task = this.run(this.abort.signal);
    }
    async stop(): Promise<void> {
        const task = this.task;
        this.abort?.abort();
        await task;
        if (this.task === task) {
            this.task = undefined;
            this.abort = undefined;
        }
    }
    private publish(state: OutboundState): void {
        this.state = state;
        try {
            this.onState(state);
        } catch {
            /* Reporting cannot break durable processing. */
        }
    }
    private async run(signal: AbortSignal): Promise<void> {
        try {
            while (!signal.aborted) {
                this.publish('processing');
                let failed = false;
                try {
                    this.ingress.drain(this.batchSize);
                } catch {
                    failed = true;
                }
                for (let count = 0; count < this.batchSize && !signal.aborted; count++) {
                    try {
                        if (!(await this.worker.flushOne())) break;
                    } catch {
                        failed = true; /* Deferred or uncertain rows must not block other chats. */
                    }
                }
                if (signal.aborted) break;
                this.publish(failed ? 'retrying' : 'waiting');
                try {
                    await delay(this.intervalMs, undefined, {signal});
                } catch {
                    if (!signal.aborted) throw new Error('Outbound dispatcher timer failed');
                }
            }
        } finally {
            this.publish('stopped');
        }
    }
}
