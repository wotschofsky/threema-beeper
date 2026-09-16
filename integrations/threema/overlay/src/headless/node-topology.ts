import type {BackendHandle} from '~/common/dom/backend';
import type {RemoteProxy} from '~/common/utils/endpoint';
import type {StoreUnsubscriber} from '~/common/utils/store';

import {watchNodeModels} from './node-watch';

/** Collection replacement/add/remove and contact/group metadata invalidate full reconciliation. */
export async function watchNodeTopology(
    handle: RemoteProxy<BackendHandle>,
    onReset: () => void,
): Promise<() => Promise<void>> {
    let active = true;
    const subscriptions: StoreUnsubscriber[] = [];
    function stop(): void {
        active = false;
        for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe();
        }
    }
    function reset(): void {
        if (!active) {
            return;
        }
        stop();
        try {
            onReset();
        } catch {
            // Reporting failures must not propagate into upstream store notifications.
        }
    }
    function add(unsubscribe: StoreUnsubscriber): void {
        if (active) {
            subscriptions.push(unsubscribe);
        } else {
            unsubscribe();
        }
    }
    const callbacks = {upsert: reset, remove: reset, reset, failed: reset};
    try {
        // The conversation list listener comes first, before callers enumerate any chats.
        const conversations = await handle.model.conversations.getAll();
        // The cache is weak: retain the collection as well as its delta controller.
        add(conversations.subscribe(() => undefined));
        add(conversations.delta.subscribe(reset));
        const contacts = await handle.model.contacts.getAll();
        add(watchNodeModels(contacts, callbacks, {emitSnapshot: false}));
        const groups = await handle.model.groups.getAll();
        add(watchNodeModels(groups, callbacks, {emitSnapshot: false}));
        const privacy = await handle.model.user.privacySettings;
        let initialPrivacy = true;
        add(
            privacy.subscribe(() => {
                if (initialPrivacy) {
                    initialPrivacy = false;
                    return;
                }
                reset();
            }),
        );
        // eslint-disable-next-line @typescript-eslint/require-await -- Match asynchronous subscription cleanup while local unsubscription is synchronous.
        return async () => {
            stop();
        };
    } catch (error) {
        stop();
        throw error;
    }
}
