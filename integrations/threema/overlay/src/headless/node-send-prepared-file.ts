import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState, ReceiverType} from '~/common/enum';
import {TRANSFER_HANDLER} from '~/common/index';
import type {MessageId} from '~/common/network/types';
import {PROXY_HANDLER, type RemoteProxy} from '~/common/utils/endpoint';

import {nodeChatId} from './node-conversations';

export interface NodePreparedFileSend {
    readonly profile: string;
    readonly chatId: string;
    readonly token: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly caption?: string;
    readonly audioDurationSeconds?: number;
}

/** Resolve the owned conversation and reuse Desktop's send preparation/controller. */
export async function sendNodePreparedFile(
    handle: RemoteProxy<BackendHandle>,
    request: NodePreparedFileSend,
    beforeSend: (ids: readonly string[]) => Promise<void>,
): Promise<readonly string[]> {
    if (
        (request.audioDurationSeconds !== undefined &&
            (request.mediaType !== 'audio/mp4' ||
                typeof request.audioDurationSeconds !== 'number' ||
                !Number.isFinite(request.audioDurationSeconds) ||
                request.audioDurationSeconds <= 0 ||
                request.audioDurationSeconds > 10000)) ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/u.test(request.profile) ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/u.test(request.chatId) ||
        !/^[a-f0-9]{64}$/u.test(request.token) ||
        typeof request.fileName !== 'string' ||
        !request.fileName ||
        new TextEncoder().encode(request.fileName).byteLength > 1024 ||
        typeof request.mediaType !== 'string' ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(request.mediaType) ||
        (request.caption !== undefined &&
            (typeof request.caption !== 'string' ||
                new TextEncoder().encode(request.caption).byteLength >
                    import.meta.env.MAX_TEXT_MESSAGE_BYTES))
    ) {
        throw new Error('INVALID_ARGUMENT');
    }
    request = {...request};
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
        // The upstream endpoint type mapper loses the callable callback shape; preserve its runtime proxy marker.
        const send = bundle.viewModelController.sendPreparedFileWithIds as unknown as (
            token: string,
            metadata: {
                fileName: string;
                mediaType: string;
                caption?: string;
                audioDurationSeconds?: number;
            },
            recorder: typeof callback,
        ) => Promise<readonly MessageId[]>;
        const ids = await Reflect.apply(send, bundle.viewModelController, [
            request.token,
            {
                fileName: request.fileName,
                mediaType: request.mediaType,
                ...(request.audioDurationSeconds === undefined
                    ? {}
                    : {audioDurationSeconds: request.audioDurationSeconds}),
                ...(request.caption === undefined ? {} : {caption: request.caption}),
            },
            callback,
        ]);
        return ids.map((id) => `m:${u64ToHexLe(id)}`);
    }
    throw new Error('NOT_FOUND');
}
