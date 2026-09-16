import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState, ReceiverType} from '~/common/enum';
import {TRANSFER_HANDLER} from '~/common/index';
import type {MessageId} from '~/common/network/types';
import {PROXY_HANDLER, type RemoteProxy} from '~/common/utils/endpoint';

import {nodeChatId} from './node-conversations';

export interface NodePreparedVideoSend {
    readonly profile: string;
    readonly chatId: string;
    readonly token: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly caption?: string;
    readonly durationSeconds: number;
    readonly thumbnailToken?: string;
    readonly thumbnailMediaType?: 'image/png' | 'image/jpeg';
    readonly width: number;
    readonly height: number;
    readonly thumbnailWidth?: number;
    readonly thumbnailHeight?: number;
}

/** Resolve the owned conversation and reuse Desktop's send preparation/controller. */
export async function sendNodePreparedVideo(
    handle: RemoteProxy<BackendHandle>,
    request: NodePreparedVideoSend,
    beforeSend: (ids: readonly string[]) => Promise<void>,
): Promise<readonly string[]> {
    const dimension = (value: unknown, maximum: number): boolean =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
    const thumbnailKeys = [
        'thumbnailToken',
        'thumbnailMediaType',
        'thumbnailWidth',
        'thumbnailHeight',
    ];
    const hasThumbnail = thumbnailKeys.some((key) => key in request);
    if (
        Object.keys(request).some(
            (key) =>
                ![
                    'profile',
                    'chatId',
                    'token',
                    'fileName',
                    'mediaType',
                    'caption',
                    'durationSeconds',
                    'width',
                    'height',
                    ...thumbnailKeys,
                ].includes(key),
        ) ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/u.test(request.profile) ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/u.test(request.chatId) ||
        !/^[a-f0-9]{64}$/u.test(request.token) ||
        request.mediaType !== 'video/mp4' ||
        typeof request.durationSeconds !== 'number' ||
        !Number.isFinite(request.durationSeconds) ||
        request.durationSeconds <= 0 ||
        request.durationSeconds > 10000 ||
        !dimension(request.width, 8192) ||
        !dimension(request.height, 8192) ||
        typeof request.fileName !== 'string' ||
        !request.fileName ||
        new TextEncoder().encode(request.fileName).byteLength > 1024 ||
        /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(request.fileName) ||
        request.fileName === '.' ||
        request.fileName === '..' ||
        (request.caption !== undefined &&
            (typeof request.caption !== 'string' ||
                new TextEncoder().encode(request.caption).byteLength >
                    import.meta.env.MAX_TEXT_MESSAGE_BYTES)) ||
        (hasThumbnail &&
            (!thumbnailKeys.every((key) => key in request) ||
                typeof request.thumbnailToken !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(request.thumbnailToken) ||
                request.thumbnailToken === request.token ||
                (request.thumbnailMediaType !== 'image/png' &&
                    request.thumbnailMediaType !== 'image/jpeg') ||
                !dimension(request.thumbnailWidth, 512) ||
                !dimension(request.thumbnailHeight, 512)))
    )
        throw new Error('INVALID_ARGUMENT');
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
        const send = bundle.viewModelController.sendPreparedVideoWithIds as unknown as (
            token: string,
            thumbnailToken: string | undefined,
            metadata: {
                fileName: string;
                mediaType: string;
                caption?: string;
                durationSeconds: number;
                thumbnailMediaType?: string;
                dimensions: {width: number; height: number};
                thumbnailDimensions?: {width: number; height: number};
            },
            recorder: typeof callback,
        ) => Promise<readonly MessageId[]>;
        const ids = await Reflect.apply(send, bundle.viewModelController, [
            request.token,
            request.thumbnailToken,
            {
                durationSeconds: request.durationSeconds,
                dimensions: {width: request.width, height: request.height},
                ...(hasThumbnail
                    ? {
                          thumbnailMediaType: request.thumbnailMediaType,
                          thumbnailDimensions: {
                              width: request.thumbnailWidth!,
                              height: request.thumbnailHeight!,
                          },
                      }
                    : {}),
                fileName: request.fileName,
                mediaType: request.mediaType,
                ...(request.caption === undefined ? {} : {caption: request.caption}),
            },
            callback,
        ]);
        return ids.map((id) => `m:${u64ToHexLe(id)}`);
    }
    throw new Error('NOT_FOUND');
}
