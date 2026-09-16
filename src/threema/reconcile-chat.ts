import type {BackendController} from './backend-controller.ts';
import type {MessageJournal} from './message-journal.ts';
import {parseHistoryPage, type HistoryCursor} from './history.ts';

/** Stage snapshot and observed live changes separately; atomically publish snapshot then live. */
export async function reconcileChat(
    source: Pick<BackendController, 'history' | 'watchMessages'>,
    journal: MessageJournal,
    chatId: string,
    options: {signal?: AbortSignal; onReset: () => void; pageSize?: number},
): Promise<() => Promise<void>> {
    options.signal?.throwIfAborted();
    const token = journal.beginReconciliation(chatId);
    let staging = true;
    let invalidated = false;
    let stopSource: (() => Promise<void>) | undefined;
    let stopping: Promise<void> | undefined;
    function stop(): Promise<void> {
        invalidated = true;
        options.signal?.removeEventListener('abort', reset);
        if (!stopping)
            stopping = Promise.resolve()
                .then(() => stopSource?.())
                .finally(() => journal.abortReconciliation(token));
        return stopping;
    }
    function reset(): void {
        if (invalidated) return;
        invalidated = true;
        try {
            options.onReset();
        } catch {
            /* Reporting must not strand cleanup. */
        }
        void stop().catch(() => undefined);
    }
    function check(): void {
        options.signal?.throwIfAborted();
        if (invalidated) throw new Error('Reconciliation invalidated');
    }
    options.signal?.addEventListener('abort', reset, {once: true});
    try {
        stopSource = await source.watchMessages(
            chatId,
            async (message) => {
                check();
                try {
                    if (staging) journal.stage(token, 'live', message);
                    else journal.upsert(message);
                } catch (error) {
                    reset();
                    throw error;
                }
            },
            reset,
        );
        check();
        let after: HistoryCursor | undefined;
        do {
            const limit = options.pageSize ?? 100;
            const page = parseHistoryPage(await source.history(chatId, limit, after), {
                chatId,
                limit,
                after,
            });
            check();
            for (const message of page.messages) journal.stage(token, 'snapshot', message);
            after = page.next;
        } while (after !== undefined);
        check();
        // No await between publication and switching to live: callbacks cannot slip between them.
        journal.commitReconciliation(token);
        staging = false;
        return stop;
    } catch (error) {
        await stop();
        // A reset may finish cleanup before asynchronous subscription attachment returns.
        await stopSource?.();
        throw error;
    }
}
