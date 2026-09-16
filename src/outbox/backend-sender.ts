import {DispatchGuard, type DispatchGuardOptions} from './dispatch-guard.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import type {OutboundTextSender} from './worker.ts';

/** The backend acknowledgement is sent only after the outbox's persistence hook completes. */
export function createBackendTextSender(
    backend: Pick<BackendController, 'sendText'>,
    options: DispatchGuardOptions,
): OutboundTextSender {
    const guard = new DispatchGuard(options);
    return {
        check: (request) => guard.check(request),
        send: (request, persist) => backend.sendText(request, persist),
    };
}
