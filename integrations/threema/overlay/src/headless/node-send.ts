import {hexLeToU64} from '@threema/ts-utils/number/hex-le-to-u64';
import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState, ReceiverType} from '~/common/enum';
import {TRANSFER_HANDLER} from '~/common/index';
import {ensureMessageId, type MessageId} from '~/common/network/types';
import {PROXY_HANDLER, type RemoteProxy} from '~/common/utils/endpoint';

import {nodeChatId} from './node-conversations';

export interface NodeTextSend {
    readonly profile: string;
    readonly chatId: string;
    readonly text: string;
    readonly replyTo?: string;
}

/** Resolve the owned conversation and reuse Desktop's send preparation/controller. */
export async function sendNodeText(
    handle: RemoteProxy<BackendHandle>,
    request: NodeTextSend,
    beforeSend: (ids: readonly string[]) => Promise<void>,
): Promise<readonly string[]> {
    if (
        !/^[A-Z0-9*][A-Z0-9]{7}$/u.test(request.profile) ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/u.test(request.chatId) ||
        typeof request.text !== 'string' ||
        request.text.length === 0 ||
        new TextEncoder().encode(request.text).byteLength >
            import.meta.env.MAX_TEXT_MESSAGE_BYTES ||
        (request.replyTo !== undefined && !/^m:[0-9a-f]{16}$/u.test(request.replyTo))
    ) {
        throw new Error('INVALID_ARGUMENT');
    }
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) {
        throw new Error('NOT_AUTHORIZED');
    }
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) {
            continue;
        }
        if (
            receiver.type === ReceiverType.GROUP &&
            receiver.view.userState !== GroupUserState.MEMBER
        ) {
            throw new Error('PERMISSION_DENIED');
        }
        const bundle = await handle.viewModel.conversation(
            await conversation.controller.receiverLookup,
        );
        if (bundle === undefined) {
            throw new Error('NOT_FOUND');
        }
        const callback = {
            [TRANSFER_HANDLER]: PROXY_HANDLER,
            record: async (ids: readonly MessageId[]) => {
                await beforeSend(ids.map((id) => `m:${u64ToHexLe(id)}`));
            },
        };
        const quotedMessageId =
            request.replyTo === undefined
                ? undefined
                : ensureMessageId(hexLeToU64(request.replyTo.slice(2)));
        // Upstream Local<RemoteProxy<T>> misidentifies object callbacks as PropertiesMarked:
        // its remote marker constants are typed symbol rather than unique symbol. Keep the
        // correction at this tested boundary; the runtime object uses PROXY_HANDLER.
        const send = bundle.viewModelController.sendMessageWithIds as unknown as (
            detail: {type: 'text'; text: string; quotedMessageId: MessageId | undefined},
            recorder: typeof callback,
        ) => Promise<readonly MessageId[]>;
        // The headless adapter may use a worker-local controller, whose methods require
        // their receiver. Reflect.apply also works for the Desktop endpoint proxy.
        const ids = await Reflect.apply(send, bundle.viewModelController, [
            {type: 'text', text: request.text, quotedMessageId},
            callback,
        ]);
        return ids.map((id) => `m:${u64ToHexLe(id)}`);
    }
    throw new Error('NOT_FOUND');
}
