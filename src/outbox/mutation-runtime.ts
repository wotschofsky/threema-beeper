import type {BackendController} from '../threema/backend-controller.ts';
import type {InboxEvent, TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {OutboxStore} from './store.ts';
import {DispatchGuard, type DispatchGuardOptions} from './dispatch-guard.ts';
import {MutationRecovery} from './mutation-recovery.ts';
import {MutationIngress} from './mutation-ingress.ts';
import {MutationDispatcher} from './mutation-dispatcher.ts';
import {MutationFailureNotices} from './mutation-failure-notices.ts';
import type {MutationOperation} from './mutation-journal.ts';
import {sourceOrderPermits} from './source-order.ts';

export function createMutationRuntime(
    options: DispatchGuardOptions & {
        backend: Pick<BackendController, 'mutateMessage' | 'mutationState'>;
        inbox: TransactionInbox;
        outbox: OutboxStore;
        ready: () => boolean;
        signal?: AbortSignal;
        readTimeoutMs?: number;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
        original: (event: string, room: string) => Promise<InboxEvent | undefined>;
    },
) {
    const timeoutMs = options.readTimeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        throw new Error('Invalid mutation read timeout');
    const read = async <T>(action: () => Promise<T>): Promise<T> => {
        const deadline = new AbortController();
        const signal = options.signal
            ? AbortSignal.any([options.signal, deadline.signal])
            : deadline.signal;
        signal.throwIfAborted();
        const timer = setTimeout(() => deadline.abort(), timeoutMs);
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(new Error('Mutation read interrupted'));
            signal.addEventListener('abort', abort, {once: true});
        });
        try {
            return await Promise.race([action(), cancelled]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        }
    };
    const active = {
        ...options,
        ready: () => !options.signal?.aborted && options.ready(),
        original: (event: string, room: string) => read(() => options.original(event, room)),
        backend: {
            mutateMessage: options.backend.mutateMessage.bind(options.backend),
            mutationState: (request: Parameters<BackendController['mutationState']>[0]) =>
                read(() => options.backend.mutationState(request)),
        },
    };
    const guard = new DispatchGuard(options);
    const authorize = (operation: MutationOperation) =>
        read(() =>
            guard.check({
                profile: operation.profile,
                sender: operation.owner,
                roomId: operation.room,
                chatId: operation.chat,
            }),
        );
    const common = {...active, journal: options.outbox.mutations, authorize};
    const ingress = new MutationIngress(active);
    const recovery = new MutationRecovery(common);
    const dispatcher = new MutationDispatcher({
        ...common,
        authorize: async (operation) => {
            const checkOrder = () => {
                if (
                    !sourceOrderPermits(
                        options.inbox,
                        options.outbox,
                        options.profile,
                        operation.event,
                        'dispatch',
                    )
                )
                    throw new Error('Outbound predecessor remains unsettled');
            };
            checkOrder();
            await authorize(operation);
            checkOrder();
        },
    });
    const failures = new MutationFailureNotices(common);
    return {
        async drain(limit = 100): Promise<number> {
            if (!active.ready()) return 0;
            let completed = 0,
                failed = false;
            // A failed lookup or dispatch must not starve ingress or rejection notices.
            for (const run of [
                () => ingress.drain(limit),
                () => recovery.drain(limit),
                () => dispatcher.drain(limit),
                () => failures.drain(limit),
            ]) {
                if (!active.ready()) break;
                try {
                    completed += await run();
                } catch {
                    failed = true;
                }
            }
            if (failed) throw new Error('Mutation processing requires retry or recovery');
            return Math.min(completed, limit);
        },
    };
}
