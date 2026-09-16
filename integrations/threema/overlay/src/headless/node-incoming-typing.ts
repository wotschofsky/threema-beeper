import type {BackendHandle} from '~/common/dom/backend';
import {ConnectionState, ReceiverType} from '~/common/enum';
import type {RemoteProxy} from '~/common/utils/endpoint';
import type {StoreUnsubscriber} from '~/common/utils/store';
import {nodeChatId} from './node-conversations';

/** Observe native transient typing for one contact without exporting model stores. */
export async function watchNodeTyping(
    handle: RemoteProxy<BackendHandle>,
    chatId: string,
    changed: (typing: boolean) => void,
): Promise<() => Promise<void>> {
    if (!/^c:[A-Z0-9*][A-Z0-9]{7}$/.test(chatId)) throw new Error('Invalid typing conversation');
    const identity = await handle.model.user.identity;
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const receiver = (await store.get().controller.receiver()).get();
        if (receiver.type !== ReceiverType.CONTACT || nodeChatId(receiver, identity) !== chatId)
            continue;
        const connection = await handle.connectionManager.state;
        let active = true;
        let connected = false;
        let sent: boolean | undefined;
        // A reconnect must wait for a fresh native typing transition, not replay a cached true.
        let previous = store.get().view.isTyping === true;
        const subscriptions: StoreUnsubscriber[] = [];
        const emit = (typing: boolean): void => {
            if (!active || sent === typing) return;
            sent = typing;
            try {
                changed(typing);
            } catch {
                /* Consumer errors cannot enter native stores. */
            }
        };
        const stop = (): void => {
            emit(false);
            active = false;
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        };
        try {
            subscriptions.push(
                connection.subscribe((state) => {
                    connected = state === ConnectionState.CONNECTED;
                    if (!connected) emit(false);
                }),
            );
            let initial = true;
            subscriptions.push(
                store.subscribe((conversation) => {
                    const typing = conversation.view.isTyping === true;
                    if (initial || typing !== previous) emit(connected && typing);
                    initial = false;
                    previous = typing;
                }),
            );
            // A removed conversation must not retain an indicator or a subscription.
            subscriptions.push(
                conversations.delta.subscribe(() => {
                    if (!conversations.get().has(store)) stop();
                }),
            );
            return async () => {
                stop();
            };
        } catch (error) {
            stop();
            throw error;
        }
    }
    throw new Error('Typing conversation unavailable');
}
