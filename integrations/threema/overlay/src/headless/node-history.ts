import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import type {BackendHandle} from '~/common/dom/backend';
import type {RemoteProxy} from '~/common/utils/endpoint';

import {smallestHistoryWindow} from './node-history-window';

import {nodeChatId} from './node-conversations';
import {normalizeNodeMessage, type NormalizedNodeMessage} from './node-message';

export interface HistoryCursor {
    readonly ordinal: string;
    readonly messageId: string;
}
export interface HistoryPage {
    readonly messages: NormalizedNodeMessage[];
    readonly next?: HistoryCursor;
}

/** Retained local history only. Live watchers must already be attached during reconciliation. */
export async function readNodeHistoryPage(
    handle: RemoteProxy<BackendHandle>,
    chatId: string,
    limit: number,
    after?: HistoryCursor,
): Promise<HistoryPage> {
    if (
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/u.test(chatId) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500
    ) {
        throw new Error('Invalid history request');
    }
    if (
        after !== undefined &&
        (!/^(?:0|[1-9][0-9]{0,15})$/u.test(after.ordinal) ||
            BigInt(after.ordinal) > BigInt(Number.MAX_SAFE_INTEGER) ||
            !/^m:[0-9a-f]{16}$/u.test(after.messageId))
    ) {
        throw new Error('Invalid history cursor');
    }
    const ownIdentity = await handle.model.user.identity;
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, ownIdentity) !== chatId) {
            continue;
        }
        const messages = await conversation.controller.getAllMessages();
        const afterOrdinal = after === undefined ? undefined : BigInt(after.ordinal);
        function* candidates() {
            for (const messageStore of messages.get()) {
                const model = messageStore.get();
                const ordinal = BigInt(model.view.ordinal);
                const messageId = `m:${u64ToHexLe(model.view.id)}`;
                if (after !== undefined && afterOrdinal !== undefined &&
                    (ordinal < afterOrdinal || (ordinal === afterOrdinal && messageId <= after.messageId))) {
                    continue;
                }
                yield {model, ordinal, messageId};
            }
        }
        // One extra candidate determines whether another page exists.
        const window = smallestHistoryWindow(candidates(), limit + 1, (a, b) => {
            if (a.ordinal < b.ordinal) {
                return -1;
            }
            if (a.ordinal > b.ordinal) {
                return 1;
            }
            if (a.messageId < b.messageId) {
                return -1;
            }
            if (a.messageId > b.messageId) {
                return 1;
            }
            return 0;
        });
        const selected = window.slice(0, limit);
        const normalized: NormalizedNodeMessage[] = [];
        for (const item of selected) {
            normalized.push(await normalizeNodeMessage(item.model, chatId, ownIdentity));
        }
        const last = selected.at(-1);
        return {
            messages: normalized,
            next:
                window.length > limit && last !== undefined
                    ? {ordinal: last.ordinal.toString(), messageId: last.messageId}
                    : undefined,
        };
    }
    throw new Error('Conversation not found');
}
