import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import type {BackendHandle} from '~/common/dom/backend';
import {ConversationVisibility, ReceiverType} from '~/common/enum';
import type {RemoteModelFor} from '~/common/model/types/common';
import type {AnyReceiver} from '~/common/model/types/receiver';
import type {RemoteProxy} from '~/common/utils/endpoint';

/** A point-in-time enumeration, not the canonical change subscription. No stores leave the worker. */
export async function listNodeConversations(handle: RemoteProxy<BackendHandle>): Promise<
    {
        chatId: string;
        name: string;
        unreadCount: number;
        archived: boolean;
        pinned: boolean;
        lastMessageId?: string;
    }[]
> {
    const identity = await handle.model.user.identity;
    const conversations = await handle.model.conversations.getAll();
    const result = [];
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (receiver.type === ReceiverType.DISTRIBUTION_LIST) {
            throw new Error('Unsupported conversation receiver');
        }
        const chatId = nodeChatId(receiver, identity);
        const last = (await conversation.controller.lastMessageStore()).get()?.get();
        result.push({
            chatId,
            name: receiver.view.displayName,
            unreadCount: conversation.view.unreadMessageCount,
            archived: conversation.view.visibility === ConversationVisibility.ARCHIVED,
            pinned: conversation.view.visibility === ConversationVisibility.PINNED,
            lastMessageId: last === undefined ? undefined : `m:${u64ToHexLe(last.view.id)}`,
        });
    }
    return result.sort((a, b) => a.chatId.localeCompare(b.chatId, 'en'));
}

export function nodeChatId(receiver: RemoteModelFor<AnyReceiver>, identity: string): string {
    switch (receiver.type) {
        case ReceiverType.CONTACT:
            return `c:${receiver.view.identity}`;
        case ReceiverType.GROUP: {
            const creator =
                receiver.view.creator === 'me'
                    ? identity
                    : receiver.view.creator.get().view.identity;
            return `g:${creator}:${u64ToHexLe(receiver.view.groupId)}`;
        }
        default:
            throw new Error('Unsupported conversation receiver');
    }
}
