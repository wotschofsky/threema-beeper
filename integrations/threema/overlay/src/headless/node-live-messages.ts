import type {BackendHandle} from '~/common/dom/backend';
import type {RemoteModelFor} from '~/common/model/types/common';
import type {AnyMessageModel} from '~/common/model/types/message';
import type {RemoteProxy} from '~/common/utils/endpoint';
import type {StoreUnsubscriber} from '~/common/utils/store';

import {nodeChatId} from './node-conversations';
import {normalizeNodeMessage, type NormalizedNodeMessage} from './node-message';
import {watchNodeModels} from './node-watch';

/** Attach before reading history. Initial values are covered by history; later updates are ordered. */
export async function watchNodeMessages(
    handle: RemoteProxy<BackendHandle>,
    chatId: string,
    consume: (message: NormalizedNodeMessage) => Promise<void>,
    onReset: () => void,
): Promise<() => Promise<void>> {
    const identity = await handle.model.user.identity;
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        if (nodeChatId((await conversation.controller.receiver()).get(), identity) !== chatId) {
            continue;
        }
        const messages = await conversation.controller.getAllMessages();
        type MessageStore =
            ReturnType<typeof messages.get> extends ReadonlySet<infer S> ? S : never;
        let active = true;
        let pending = 0;
        let queue = Promise.resolve();
        let unsubscribe: StoreUnsubscriber | undefined = undefined;
        function reset(): void {
            if (!active) {
                return;
            }
            active = false;
            unsubscribe?.();
            try {
                onReset();
            } catch {
                // Reset reporting must not reject the ordered queue or upstream callbacks.
            }
        }
        function changed(model: RemoteModelFor<AnyMessageModel>): void {
            if (!active) {
                return;
            }
            if (++pending > 2048) {
                reset();
                return;
            }
            // Begin normalization at notification time, retaining this model version. Attach an
            // error handler immediately even though ordered consumption may wait for older events.
            const normalized = normalizeNodeMessage(model, chatId, identity).then(
                (value) => ({ok: true as const, value}),
                () => ({ok: false as const}),
            );
            queue = queue.then(async () => {
                try {
                    const result = await normalized;
                    if (!active) {
                        return;
                    }
                    if (!result.ok) {
                        reset();
                        return;
                    }
                    await consume(result.value);
                } catch {
                    reset();
                } finally {
                    pending--;
                }
            });
        }
        unsubscribe = watchNodeModels<RemoteModelFor<AnyMessageModel>, MessageStore>(
            messages,
            {
                upsert: (_, model) => changed(model),
                // Physical removal is not a remote deletion: reconcile retained state instead of
                // redacting a Matrix event. Deleted-message models arrive as ordinary upserts.
                remove: reset,
                reset,
                failed: reset,
            },
            {emitSnapshot: false},
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Initial callbacks can reset synchronously while attaching.
        if (!active) {
            unsubscribe();
        }
        return async () => {
            active = false;
            unsubscribe();
            await queue;
        };
    }
    throw new Error('Conversation not found');
}
