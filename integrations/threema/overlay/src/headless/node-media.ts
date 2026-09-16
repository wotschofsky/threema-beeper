import type {Readable} from 'node:stream';

import {hexLeToU64} from '@threema/ts-utils/number/hex-le-to-u64';

import type {BackendHandle} from '~/common/dom/backend';
import {MessageType} from '~/common/enum';
import type {CopyableFileStorage} from '~/common/file-storage';
import {ensureMessageId} from '~/common/network/types';
import type {RemoteProxy} from '~/common/utils/endpoint';

import {nodeChatId} from './node-conversations';
import {describeNodeStoredFile, openNodeStoredFile} from './node-file-stream';

export interface NodeMediaRequest {
    readonly chatId: string;
    readonly messageId: string;
    readonly part: 'file' | 'thumbnail';
    readonly maximumBytes: number;
}
export interface NodeMediaSource {
    readonly bytes: number;
    readonly sha256: string;
    readonly mimeType: string;
    readonly open: (signal?: AbortSignal) => Readable;
}

/** Resolve local retained media only; neither key material nor filesystem paths leave this closure. */
export async function resolveNodeMedia(
    handle: RemoteProxy<BackendHandle>,
    storage: Pick<CopyableFileStorage, 'getRawPath'>,
    request: NodeMediaRequest,
    signal?: AbortSignal,
): Promise<NodeMediaSource> {
    if (
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/u.test(request.chatId) ||
        !/^m:[0-9a-f]{16}$/u.test(request.messageId) ||
        !(['file', 'thumbnail'] as readonly unknown[]).includes(request.part) ||
        !Number.isSafeInteger(request.maximumBytes) ||
        request.maximumBytes < 0 ||
        request.maximumBytes > 1024 ** 3
    ) {
        throw new Error('Invalid media request');
    }
    const own = await handle.model.user.identity;
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        signal?.throwIfAborted();
        const conversation = store.get();
        if (nodeChatId((await conversation.controller.receiver()).get(), own) !== request.chatId) {
            continue;
        }
        const messageStore = await conversation.controller.getMessage(
            ensureMessageId(hexLeToU64(request.messageId.slice(2))),
        );
        let message = messageStore?.get();
        if (message === undefined) {
            throw new Error('MEDIA_MESSAGE_NOT_FOUND');
        }
        if (
            message.type !== MessageType.IMAGE &&
            message.type !== MessageType.VIDEO &&
            message.type !== MessageType.AUDIO &&
            message.type !== MessageType.FILE
        ) {
            throw new Error('MEDIA_MESSAGE_UNSUPPORTED');
        }
        if (message.view.fileSize > request.maximumBytes) {
            throw new Error('MEDIA_TOO_LARGE');
        }
        if (
            (request.part === 'file' ? message.view.fileData : message.view.thumbnailFileData) ===
            undefined
        ) {
            await message.controller.ensureCached(request.part);
            signal?.throwIfAborted();
            message = messageStore?.get();
            if (
                message === undefined ||
                (message.type !== MessageType.IMAGE &&
                    message.type !== MessageType.VIDEO &&
                    message.type !== MessageType.AUDIO &&
                    message.type !== MessageType.FILE)
            ) {
                throw new Error('MEDIA_MESSAGE_UNSUPPORTED');
            }
        }
        const view = message.view;
        const data = request.part === 'file' ? view.fileData : view.thumbnailFileData;
        const mimeType = request.part === 'file' ? view.mediaType : view.thumbnailMediaType;
        if (data === undefined) {
            throw new Error('MEDIA_NOT_CACHED');
        }
        if (mimeType === undefined || mimeType.length === 0) {
            throw new Error('MEDIA_METADATA_MISSING');
        }
        if (request.part === 'file' && data.unencryptedByteCount !== view.fileSize) {
            throw new Error('MEDIA_SIZE_MISMATCH');
        }
        const saved = {...data};
        const description = await describeNodeStoredFile(
            storage,
            saved,
            request.maximumBytes,
            signal,
        );
        return {
            ...description,
            mimeType,
            open: (abort) => openNodeStoredFile(storage, saved, request.maximumBytes, abort),
        };
    }
    throw new Error('MEDIA_CONVERSATION_NOT_FOUND');
}
