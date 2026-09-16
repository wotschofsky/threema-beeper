import type {BackendController} from '../threema/backend-controller.ts';
import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {OutboxStore} from './store.ts';
import type {DispatchGuardOptions} from './dispatch-guard.ts';
import {createBackendTextSender} from './backend-sender.ts';
import {MatrixOutboxIngress} from './matrix-ingress.ts';
import {OutboxDispatcher, type OutboundState} from './dispatcher.ts';
import {sourceOrderPermits} from './source-order.ts';

/** Assemble outbound ingestion, room authorization and backend dispatch for an owned profile. */
export function createOutboundDispatcher(
    options: DispatchGuardOptions & {
        backend: Pick<BackendController, 'sendText'>;
        inbox: TransactionInbox;
        outbox: OutboxStore;
        ready: () => boolean;
        intervalMs?: number;
        onState?: (state: OutboundState) => void;
    },
): OutboxDispatcher {
    const sender = createBackendTextSender(options.backend, options);
    return new OutboxDispatcher({
        store: options.outbox,
        ingress: new MatrixOutboxIngress({...options, outbox: options.outbox}),
        sender: {
            ...sender,
            check: async (request) => {
                const checkOrder = () => {
                    if (
                        !sourceOrderPermits(
                            options.inbox,
                            options.outbox,
                            options.profile,
                            request.eventId,
                            'dispatch',
                        )
                    )
                        throw new Error('Outbound predecessor remains unsettled');
                };
                checkOrder();
                await sender.check!(request);
                checkOrder();
            },
        },
        ready: options.ready,
        intervalMs: options.intervalMs,
        onState: options.onState,
    });
}
