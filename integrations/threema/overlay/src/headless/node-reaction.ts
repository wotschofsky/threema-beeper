import {hexLeToU64} from '@threema/ts-utils/number/hex-le-to-u64';
import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState, MessageType, ReceiverType} from '~/common/enum';
import {ensureMessageId, ensureEmojiReaction} from '~/common/network/types';
import {isSingleUnicodeEmoji} from '~/common/utils/emoji';
import type {RemoteProxy} from '~/common/utils/endpoint';
import {nodeChatId} from './node-conversations';
import type {NodeReactionRequest} from './node-reaction-types';
export type {NodeReactionRequest} from './node-reaction-types';

class ReactionRejection extends Error {
    readonly type: string;
    constructor(type: string) {super(type); this.type = type;}
}

/** Use the same model operations as Desktop's regular-message reaction controller. */
async function resolveReactionMessage(handle: RemoteProxy<BackendHandle>, request: NodeReactionRequest, mutation: boolean) {
    if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(request.profile) ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(request.chatId) ||
        !/^m:[0-9a-f]{16}$/.test(request.messageId) ||
        typeof request.emoji !== 'string' || !isSingleUnicodeEmoji(request.emoji) ||
        !['apply', 'withdraw'].includes(request.action)) throw new ReactionRejection('reaction-invalid');
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) throw new ReactionRejection('reaction-permission-denied');
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) continue;
        if (mutation && receiver.type === ReceiverType.GROUP && receiver.view.userState !== GroupUserState.MEMBER)
            throw new ReactionRejection('reaction-permission-denied');
        const message = (await conversation.controller.getMessage(ensureMessageId(hexLeToU64(request.messageId.slice(2)))))?.get();
        if (!message) throw new ReactionRejection('reaction-not-found');
        return message;
    }
    throw new ReactionRejection('reaction-not-found');
}


export async function reactNodeMessage(handle: RemoteProxy<BackendHandle>, request: NodeReactionRequest): Promise<void> {
    const message = await resolveReactionMessage(handle, request, true);
    if (message.type === MessageType.DELETED) throw new ReactionRejection('reaction-not-found');
    const emoji = ensureEmojiReaction(request.emoji);
    if (request.action === 'apply') await message.controller.addReaction.fromLocal(emoji, new Date());
    else await message.controller.withdrawReaction.fromLocal(emoji);
}

/** Current local backend state only; not proof of recipient delivery. */
export async function readNodeReaction(handle: RemoteProxy<BackendHandle>, request: NodeReactionRequest): Promise<boolean> {
    const message = await resolveReactionMessage(handle, request, false);
    if (message.type === MessageType.DELETED) return false;
    return message.view.reactions.some(reaction => reaction.senderIdentity === request.profile && reaction.reaction === request.emoji);
}
