import type {BackendController} from '../threema/backend-controller.ts';
import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {OutboxStore} from './store.ts';
import {DispatchGuard, type DispatchGuardOptions} from './dispatch-guard.ts';
import {ReactionIngress} from './reaction-ingress.ts';
import {ReactionDispatcher} from './reaction-dispatcher.ts';
import {ReactionRecovery} from './reaction-recovery.ts';
import {ReactionFailureNotices} from './reaction-failure-notices.ts';
import type {ReactionOperation} from './reaction-journal.ts';
import {ReactionRetirementWorker} from './reaction-retirement.ts';
import {sourceOrderPermits} from './source-order.ts';

export function createReactionRuntime(
    options: DispatchGuardOptions & {
        backend: Pick<BackendController, 'reactMessage' | 'reactionState'>;
        inbox: TransactionInbox;
        outbox: OutboxStore;
        ready: () => boolean;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
        redact: (id: string, room: string, event: string) => Promise<unknown>;
    },
) {
    const guard = new DispatchGuard(options);
    const authorize = (operation: ReactionOperation) =>
        guard.check({
            profile: operation.profile,
            sender: operation.owner,
            roomId: operation.room,
            chatId: operation.chat,
        });
    const common = {...options, journal: options.outbox.reactions, authorize};
    const ingress = new ReactionIngress(options);
    const recovery = new ReactionRecovery(common);
    const dispatcher = new ReactionDispatcher({
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
    const failures = new ReactionFailureNotices(common);
    const retirements = new ReactionRetirementWorker(options.profile, common);
    return {
        async drain(limit = 100): Promise<number> {
            if (!options.ready()) return 0;
            let completed = 0,
                failed = false;
            // A failed recovery or send must not starve ingress or rejection notices.
            for (const run of [
                () => ingress.drain(limit),
                () => recovery.drain(limit),
                () => dispatcher.drain(limit),
                () => failures.drain(limit),
                () => retirements.drain(limit),
            ]) {
                if (!options.ready()) break;
                try {
                    completed += await run();
                } catch {
                    failed = true;
                }
            }
            if (failed) throw new Error('Reaction processing requires retry or recovery');
            return Math.min(completed, limit);
        },
    };
}
