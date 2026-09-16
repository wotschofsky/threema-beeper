import {createMediaReply} from './media-reply.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {createFilePreparation} from '../media/file-preparation.ts';
import type {OutboxStore} from './store.ts';
import {DispatchGuard, type DispatchGuardOptions} from './dispatch-guard.ts';
import {MediaIngress} from './media-ingress.ts';
import {MediaDispatcher} from './media-dispatcher.ts';
import {sourceOrderPermits} from './source-order.ts';

export function createMediaRuntime(
    options: DispatchGuardOptions & {
        inbox: TransactionInbox;
        outbox: OutboxStore;
        maximumBytes: number;
        ready: () => boolean;
        prepare: ReturnType<typeof createFilePreparation>;
        backend: Pick<BackendController, 'sendPreparedFile'> &
            Partial<Pick<BackendController, 'sendText'>>;
        attachmentReplies?: boolean;
        images?: ConstructorParameters<typeof MediaDispatcher>[0]['images'];
        audio?: ConstructorParameters<typeof MediaDispatcher>[0]['audio'];
        videos?: ConstructorParameters<typeof MediaDispatcher>[0]['videos'];
    },
) {
    if (options.attachmentReplies && !options.backend.sendText)
        throw new Error('Attachment replies require text sending');
    const ingress = new MediaIngress({
        ...options,
        imagesEnabled: options.images !== undefined,
        audioEnabled: options.audio !== undefined,
        videosEnabled: options.videos !== undefined,
    });
    const guard = new DispatchGuard(options);
    const dispatcher = new MediaDispatcher({
        ...options,
        journal: options.outbox.media,
        reply:
            options.attachmentReplies && options.backend.sendText
                ? createMediaReply({
                      ...options,
                      send: (request, persist) => options.backend.sendText!(request, persist),
                  })
                : undefined,
        authorize: async (request) => {
            const checkOrder = () => {
                if (
                    !sourceOrderPermits(
                        options.inbox,
                        options.outbox,
                        options.profile,
                        request.event,
                        'dispatch',
                    )
                )
                    throw new Error('Outbound predecessor remains unsettled');
            };
            checkOrder();
            await guard.check({
                profile: request.profile,
                sender: request.owner,
                roomId: request.room,
                chatId: request.media.chat,
            });
            checkOrder();
        },
    });
    return {
        async drain(limit = 100): Promise<number> {
            if (!options.ready()) return 0;
            let completed = 0,
                failed = false;
            // A blocked ingress page must not prevent already-classified files from settling.
            for (const run of [() => ingress.drain(limit), () => dispatcher.drain(limit)]) {
                if (!options.ready()) break;
                try {
                    completed += await run();
                } catch {
                    failed = true;
                }
            }
            if (failed) throw new Error('Media processing requires retry or recovery');
            return Math.min(completed, limit);
        },
    };
}
