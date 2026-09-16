import {hexLeToU64} from '@threema/ts-utils/number/hex-le-to-u64';
import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState, MessageDirection, MessageType, ReceiverType} from '~/common/enum';
import {
    EDIT_MESSAGE_GRACE_PERIOD_IN_MINUTES,
    DELETE_MESSAGE_GRACE_PERIOD_IN_MINUTES,
} from '~/common/network/protocol/constants';
import {ensureMessageId, FEATURE_MASK_FLAG} from '~/common/network/types';
import type {RemoteProxy} from '~/common/utils/endpoint';
import {nodeChatId} from './node-conversations';
import type {NodeMutationRequest} from './node-mutation-types';
export type {NodeMutationRequest} from './node-mutation-types';

class MutationRejection extends Error {
    public readonly type: string;
    public constructor(type: string) {
        super(type);
        this.type = type;
    }
}

/** Use Desktop's model operations only after checking policy omitted by its low-level controllers. */
export async function mutateNodeMessage(
    handle: RemoteProxy<BackendHandle>,
    value: NodeMutationRequest,
): Promise<void> {
    const request = validateMutationRequest(value);
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) throw new MutationRejection('mutation-permission-denied');
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) continue;
        if (
            receiver.type === ReceiverType.GROUP &&
            receiver.view.userState !== GroupUserState.MEMBER
        )
            throw new MutationRejection('mutation-permission-denied');
        const id = ensureMessageId(hexLeToU64(request.messageId.slice(2)));
        const bundle = await handle.viewModel.conversation(
            await conversation.controller.receiverLookup,
        );
        if (!bundle) throw new MutationRejection('mutation-not-found');
        const features = bundle.viewModelStore.get()?.supportedFeatures;
        const feature =
            request.action === 'edit'
                ? FEATURE_MASK_FLAG.EDIT_MESSAGE_SUPPORT
                : FEATURE_MASK_FLAG.DELETED_MESSAGES_SUPPORT;
        if (!features?.get(feature)?.supported) throw new MutationRejection('mutation-unsupported');
        const message = (await conversation.controller.getMessage(id))?.get();
        if (!message || message.type === MessageType.DELETED)
            throw new MutationRejection('mutation-not-found');
        if (message.ctx !== MessageDirection.OUTBOUND || message.view.sentAt === undefined)
            throw new MutationRejection('mutation-permission-denied');
        if (
            request.action === 'edit' &&
            (message.type === MessageType.AUDIO || message.type === MessageType.POLL)
        )
            throw new MutationRejection('mutation-unsupported');
        const notes =
            receiver.type === ReceiverType.GROUP &&
            receiver.view.creator === 'me' &&
            receiver.view.members.size === 0;
        const now = new Date();
        const sentAt = message.view.sentAt.getTime();
        if (!Number.isFinite(sentAt)) throw new MutationRejection('mutation-invalid');
        const minutes =
            request.action === 'edit'
                ? EDIT_MESSAGE_GRACE_PERIOD_IN_MINUTES
                : DELETE_MESSAGE_GRACE_PERIOD_IN_MINUTES;
        if (!notes && now.getTime() - sentAt >= minutes * 60000)
            throw new MutationRejection(
                request.action === 'edit' ? 'edit-window-expired' : 'delete-window-expired',
            );
        if (request.action === 'delete')
            await conversation.controller.markMessageAsDeleted.fromLocal(id, now);
        else {
            if (message.type === MessageType.TEXT && request.text.trim().length === 0)
                throw new MutationRejection('mutation-invalid');
            const current =
                message.type === MessageType.TEXT
                    ? message.view.text
                    : 'caption' in message.view
                      ? (message.view.caption ?? '')
                      : undefined;
            if (current === request.text) return;
            await message.controller.editMessage.fromLocal({
                newText: request.text,
                lastEditedAt: now,
            });
        }
        return;
    }
    throw new MutationRejection('mutation-not-found');
}

function validateMutationRequest(value: NodeMutationRequest): NodeMutationRequest {
    const request = {...value};
    if (
        Object.keys(request).some(
            (key) =>
                ![
                    'profile',
                    'chatId',
                    'messageId',
                    'action',
                    ...(request.action === 'edit' ? ['text'] : []),
                ].includes(key),
        ) ||
        typeof request.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(request.profile) ||
        typeof request.chatId !== 'string' ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(request.chatId) ||
        typeof request.messageId !== 'string' ||
        !/^m:[0-9a-f]{16}$/.test(request.messageId) ||
        !['edit', 'delete'].includes(request.action) ||
        (request.action === 'edit' &&
            (typeof request.text !== 'string' ||
                new TextEncoder().encode(request.text).length >
                    import.meta.env.MAX_TEXT_MESSAGE_BYTES))
    )
        throw new MutationRejection('mutation-invalid');
    return request;
}

/** Current canonical local state, not proof of delivery or of which device caused the change. */
export async function readNodeMutation(
    handle: RemoteProxy<BackendHandle>,
    value: NodeMutationRequest,
): Promise<boolean> {
    const request = validateMutationRequest(value);
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) throw new MutationRejection('mutation-permission-denied');
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) continue;
        const message = (
            await conversation.controller.getMessage(
                ensureMessageId(hexLeToU64(request.messageId.slice(2))),
            )
        )?.get();
        if (
            !message ||
            message.ctx !== MessageDirection.OUTBOUND ||
            message.view.sentAt === undefined
        )
            return false;
        if (request.action === 'delete') return message.type === MessageType.DELETED;
        if (
            message.type === MessageType.DELETED ||
            message.type === MessageType.AUDIO ||
            message.type === MessageType.POLL
        )
            return false;
        const current =
            message.type === MessageType.TEXT
                ? message.view.text
                : 'caption' in message.view
                  ? (message.view.caption ?? '')
                  : undefined;
        return current === request.text;
    }
    return false;
}
