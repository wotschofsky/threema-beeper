import {verifyExecutable} from './verified-executable.ts';
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export type ProcessState = 'idle' | 'starting' | 'running' | 'backoff' | 'stopped';
interface Options {
    executable: string;
    args: readonly string[];
    sha256?: string;
    /** Explicit environment; never implicitly inherit credentials from the bridge process. */
    env: NodeJS.ProcessEnv;
    retryMs?: number;
    maxRetryMs?: number;
    stableMs?: number;
    stopTimeoutMs?: number;
    onState?: (state: ProcessState) => void;
}

/** Own one foreground child. Clean exit is terminal (bbctl uses it for connection replacement). */
export class ProcessSupervisor {
    private readonly options: Required<Omit<Options, 'onState' | 'sha256'>> &
        Pick<Options, 'onState' | 'sha256'>;
    private readonly abort = new AbortController();
    private running?: Promise<void>;
    private current: ProcessState = 'idle';
    constructor(options: Options) {
        if (options.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.sha256))
            throw new Error('Invalid executable checksum');
        if (!isAbsolute(options.executable)) throw new Error('Invalid supervised executable');
        this.options = {
            ...options,
            args: [...options.args],
            env: {...options.env},
            retryMs: options.retryMs ?? 1000,
            maxRetryMs: options.maxRetryMs ?? 60000,
            stableMs: options.stableMs ?? 300000,
            stopTimeoutMs: options.stopTimeoutMs ?? 10000,
        };
        for (const value of [
            this.options.retryMs,
            this.options.maxRetryMs,
            this.options.stableMs,
            this.options.stopTimeoutMs,
        ])
            if (!Number.isSafeInteger(value) || value < 1 || value > 600000)
                throw new Error('Invalid process supervision interval');
        if (this.options.maxRetryMs < this.options.retryMs)
            throw new Error('Invalid process retry bound');
    }
    get state(): ProcessState {
        return this.current;
    }
    start(): void {
        if (this.running || this.abort.signal.aborted)
            throw new Error('Process supervisor already used');
        this.running = this.run();
    }
    async stop(): Promise<void> {
        this.abort.abort();
        await this.running;
        this.setState('stopped');
    }
    private setState(state: ProcessState): void {
        this.current = state;
        try {
            this.options.onState?.(state);
        } catch {
            /* Reporting cannot own child lifecycle. */
        }
    }
    private async run(): Promise<void> {
        let failures = 0;
        try {
            while (!this.abort.signal.aborted) {
                this.setState('starting');
                if (this.abort.signal.aborted) break;
                const began = performance.now();
                let clean = false;
                try {
                    if (this.options.sha256)
                        await verifyExecutable(
                            this.options.executable,
                            this.options.sha256,
                            this.abort.signal,
                        );
                    if (this.abort.signal.aborted) break;
                    clean = await this.child();
                } catch {
                    /* Failed verification follows backoff without launching the child. */
                }
                if (this.abort.signal.aborted || clean) break;
                if (performance.now() - began >= this.options.stableMs) failures = 0;
                const wait = Math.min(
                    this.options.maxRetryMs,
                    this.options.retryMs * 2 ** Math.min(failures++, 20),
                );
                this.setState('backoff');
                try {
                    await delay(wait, undefined, {signal: this.abort.signal});
                } catch {
                    /* Stop interrupts backoff. */
                }
            }
        } finally {
            this.setState('stopped');
        }
    }
    private child(): Promise<boolean> {
        return new Promise((resolve) => {
            let child;
            try {
                child = spawn(this.options.executable, [...this.options.args], {
                    shell: false,
                    detached: false,
                    stdio: 'ignore',
                    env: this.options.env,
                });
            } catch {
                resolve(false);
                return;
            }
            let timer: NodeJS.Timeout | undefined;
            let failed = false;
            const stop = () => {
                child.kill('SIGTERM');
                timer ??= setTimeout(() => child.kill('SIGKILL'), this.options.stopTimeoutMs);
            };
            child.once('spawn', () => {
                if (this.abort.signal.aborted) stop();
                else this.setState('running');
            });
            // Always wait for close, including spawn errors, before restarting or releasing ownership.
            child.once('error', () => {
                failed = true;
            });
            child.once('close', (code) => {
                if (timer) clearTimeout(timer);
                this.abort.signal.removeEventListener('abort', stop);
                resolve(!failed && code === 0);
            });
            this.abort.signal.addEventListener('abort', stop, {once: true});
            if (this.abort.signal.aborted) stop();
        });
    }
}
