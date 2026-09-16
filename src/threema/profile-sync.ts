import {setTimeout as delay} from 'node:timers/promises';
import type {BackendController} from './backend-controller.ts';
import type {MessageJournal} from './message-journal.ts';
import {parseConversations} from './conversations.ts';
import {parseDirectory} from './directory.ts';
import {parseHistoryPage, type HistoryCursor} from './history.ts';

export type ProfileSyncState = 'stopped' | 'syncing' | 'live' | 'retrying';
type Source = Pick<
    BackendController,
    'watchTopology' | 'directory' | 'conversations' | 'watchMessages' | 'history'
>;

/** Own one opened, exclusively locked profile. Consumers must gate delivery on readyForMessages. */
export class ProfileSynchronizer {
    private readonly source: Source;
    private readonly journal: MessageJournal;
    private readonly options: {
        contactOnly?: boolean;
        retryMs: number;
        periodicMs: number;
        pageSize: number;
        maxBufferedEvents: number;
        onState?: (state: ProfileSyncState) => void;
        onError?: (error: unknown) => void;
        onReconciled?: (signal: AbortSignal) => Promise<void>;
    };
    private controller?: AbortController;
    private running?: Promise<void>;
    private resetCurrent?: () => void;
    private retryWake?: AbortController;
    private manualRequested = false;
    private current: ProfileSyncState = 'stopped';
    constructor(
        source: Source,
        journal: MessageJournal,
        options: {
            contactOnly?: boolean;
            retryMs?: number;
            periodicMs?: number;
            pageSize?: number;
            maxBufferedEvents?: number;
            onState?: (state: ProfileSyncState) => void;
            onError?: (error: unknown) => void;
            onReconciled?: (signal: AbortSignal) => Promise<void>;
        } = {},
    ) {
        this.source = source;
        this.journal = journal;
        this.options = {
            contactOnly: options.contactOnly,
            pageSize: options.pageSize ?? 100,
            maxBufferedEvents: options.maxBufferedEvents ?? 10000,
            retryMs: options.retryMs ?? 1000,
            periodicMs: options.periodicMs ?? 60 * 60 * 1000,
            onState: options.onState,
            onError: options.onError,
            onReconciled: options.onReconciled,
        };
        if (
            !Number.isInteger(this.options.pageSize) ||
            this.options.pageSize < 1 ||
            this.options.pageSize > 500
        )
            throw new Error('Invalid synchronization page size');
        if (
            !Number.isSafeInteger(this.options.maxBufferedEvents) ||
            this.options.maxBufferedEvents < 1 ||
            this.options.maxBufferedEvents > 100000
        )
            throw new Error('Invalid synchronization event buffer limit');
        for (const interval of [this.options.retryMs, this.options.periodicMs])
            if (!Number.isSafeInteger(interval) || interval < 1 || interval > 86400000)
                throw new Error('Invalid synchronization interval');
    }
    get state(): ProfileSyncState {
        return this.current;
    }
    get readyForMessages(): boolean {
        return this.current === 'live' && !this.controller?.signal.aborted;
    }
    /** Coalesce requests into one fresh epoch; preserve profile credentials and durable queues. */
    resync(): boolean {
        if (!this.controller || this.controller.signal.aborted || this.current === 'stopped')
            return false;
        this.manualRequested = true;
        this.resetCurrent?.();
        this.retryWake?.abort();
        return true;
    }
    start(): void {
        if (this.running) throw new Error('Synchronization already started');
        this.controller = new AbortController();
        // The caller already owns the profile lock; no other reconciler may use this journal.
        this.journal.discardIncompleteReconciliations();
        this.running = this.run(this.controller.signal);
        void this.running.catch(() => this.setState('stopped'));
    }
    async stop(): Promise<void> {
        this.controller?.abort();
        this.setState('stopped');
        await this.running;
        this.running = undefined;
    }
    private setState(state: ProfileSyncState): void {
        this.current = state;
        try {
            this.options.onState?.(state);
        } catch {
            /* Status reporting does not own synchronization. */
        }
    }
    private async run(signal: AbortSignal): Promise<void> {
        let failures = 0;
        while (!signal.aborted) {
            this.manualRequested = false;
            this.setState('syncing');
            const epoch = new AbortController();
            const combined = AbortSignal.any([signal, epoch.signal]);
            const tokens = new Map<string, string>();
            const stops: (() => Promise<void>)[] = [];
            let staging = true;
            let bufferedEvents = 0;
            const reset = (): void => {
                if (combined.aborted) return;
                this.setState('syncing');
                epoch.abort();
            };
            this.resetCurrent = reset;
            try {
                stops.push(await this.source.watchTopology(reset));
                combined.throwIfAborted();
                const chats = parseConversations(await this.source.conversations()).filter(
                    (chat) => !this.options.contactOnly || chat.chatId.startsWith('c:'),
                );
                const directory = parseDirectory(await this.source.directory());
                combined.throwIfAborted();
                // All inner message subscriptions are attached before the first history request.
                for (const chat of chats) {
                    combined.throwIfAborted();
                    const token = this.journal.beginReconciliation(chat.chatId);
                    tokens.set(chat.chatId, token);
                    stops.push(
                        await this.source.watchMessages(
                            chat.chatId,
                            async (message) => {
                                combined.throwIfAborted();
                                try {
                                    if (staging) {
                                        // One bound for the whole profile, including repeated edits.
                                        if (bufferedEvents >= this.options.maxBufferedEvents)
                                            throw new Error(
                                                'Synchronization event buffer overflow',
                                            );
                                        this.journal.stage(token, 'live', message);
                                        bufferedEvents++;
                                    } else this.journal.upsert(message);
                                } catch (error) {
                                    reset();
                                    throw error;
                                }
                            },
                            reset,
                        ),
                    );
                }
                for (const chat of chats) {
                    let after: HistoryCursor | undefined;
                    do {
                        combined.throwIfAborted();
                        const page = parseHistoryPage(
                            await this.source.history(chat.chatId, this.options.pageSize, after),
                            {chatId: chat.chatId, limit: this.options.pageSize, after},
                        );
                        combined.throwIfAborted();
                        this.journal.stageSnapshotPage(tokens.get(chat.chatId)!, page.messages);
                        after = page.next;
                    } while (after !== undefined);
                }
                combined.throwIfAborted();
                this.journal.commitProfile([...tokens.values()], {directory, chats});
                staging = false;
                await this.options.onReconciled?.(combined);
                combined.throwIfAborted();
                failures = 0;
                this.setState('live');
                await delay(this.options.periodicMs, undefined, {signal: combined});
            } catch (error) {
                if (!signal.aborted) {
                    failures++;
                    try {
                        this.options.onError?.(error);
                    } catch {}
                }
            } finally {
                epoch.abort();
                if (!signal.aborted) this.setState('syncing');
                const cleanup = await Promise.allSettled(stops.map((stop) => stop()));
                for (const token of tokens.values()) this.journal.abortReconciliation(token);
                this.resetCurrent = undefined;
                if (cleanup.some((result) => result.status === 'rejected'))
                    throw new Error('Profile subscription cleanup failed');
            }
            if (!signal.aborted && !this.manualRequested) {
                this.retryWake = new AbortController();
                this.setState('retrying');
                try {
                    await delay(
                        Math.min(60000, this.options.retryMs * 2 ** Math.min(failures, 6)),
                        undefined,
                        {signal: AbortSignal.any([signal, this.retryWake.signal])},
                    );
                } catch {
                    /* Stop or explicit resync interrupts backoff. */
                } finally {
                    this.retryWake = undefined;
                }
            }
        }
        this.setState('stopped');
    }
}
