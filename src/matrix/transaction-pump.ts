import {setTimeout as delay} from 'node:timers/promises';
import {TransactionWorker} from './transaction-worker.ts';

export type PumpState = 'stopped' | 'processing' | 'waiting' | 'retrying';

/** Runs only the durable decoder worker. Remote bridge sends belong to a separate outbox. */
export class TransactionPump {
    private readonly worker: Pick<TransactionWorker, 'drain'>;
    private readonly intervalMs: number;
    private readonly retryMs: number;
    private readonly onState: (state: PumpState) => void;
    private abort?: AbortController;
    private task?: Promise<void>;
    private state: PumpState = 'stopped';

    constructor(
        worker: Pick<TransactionWorker, 'drain'>,
        options: {
            intervalMs?: number;
            retryMs?: number;
            onState?: (state: PumpState) => void;
        } = {},
    ) {
        this.worker = worker;
        this.intervalMs = options.intervalMs ?? 1000;
        this.retryMs = options.retryMs ?? 5000;
        for (const value of [this.intervalMs, this.retryMs]) {
            if (!Number.isSafeInteger(value) || value < 10 || value > 60000)
                throw new Error('Invalid transaction poll interval');
        }
        this.onState = options.onState ?? (() => undefined);
    }

    get status(): PumpState {
        return this.state;
    }

    start(): void {
        if (this.task) return;
        this.abort = new AbortController();
        this.task = this.run(this.abort.signal);
    }

    async stop(): Promise<void> {
        this.abort?.abort();
        await this.task;
        this.task = undefined;
        this.abort = undefined;
    }

    private publish(state: PumpState): void {
        this.state = state;
        try {
            this.onState(state);
        } catch {
            /* Observability must not break recovery. */
        }
    }

    private async run(signal: AbortSignal): Promise<void> {
        let failures = 0;
        try {
            while (!signal.aborted) {
                this.publish('processing');
                let waitMs = this.intervalMs;
                try {
                    const completed = await this.worker.drain(100);
                    failures = 0;
                    if (completed === 100) continue;
                    this.publish('waiting');
                } catch {
                    this.publish('retrying');
                    waitMs = Math.min(60000, this.retryMs * 2 ** Math.min(failures++, 16));
                }
                try {
                    await delay(waitMs, undefined, {signal});
                } catch {
                    if (!signal.aborted) throw new Error('Transaction recovery timer failed');
                }
            }
        } finally {
            this.publish('stopped');
        }
    }
}
