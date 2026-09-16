import type {ReadonlyUint8Array} from '@threema/ts-utils/array/readonly-uint8-array';

import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState, ReceiverType} from '~/common/enum';
import type {RemoteProxy} from '~/common/utils/endpoint';

import {nodeChatId} from './node-conversations';
import type {NodePreparedFiles} from './node-prepared-files';

export interface NodePrepareFile {
    readonly profile: string;
    readonly chatId: string;
    readonly bytes: number;
}
/** Stage only for the opened identity and an existing sendable conversation. */
export async function prepareNodeFile(
    handle: RemoteProxy<BackendHandle>,
    registry: NodePreparedFiles,
    request: NodePrepareFile,
    source: AsyncIterable<ReadonlyUint8Array>,
    signal?: AbortSignal,
): Promise<string> {
    request = {...request};
    if (
        !/^[A-Z0-9*][A-Z0-9]{7}$/u.test(request.profile) ||
        !Number.isSafeInteger(request.bytes) ||
        request.bytes < 0 ||
        request.bytes > import.meta.env.MAX_FILE_MESSAGE_BYTES
    ) {
        throw new Error('Invalid file preparation request');
    }
    signal?.throwIfAborted();
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) throw new Error('File preparation profile mismatch');
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const receiver = (await store.get().controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) continue;
        if (
            receiver.type === ReceiverType.GROUP &&
            receiver.view.userState !== GroupUserState.MEMBER
        ) {
            throw new Error('File preparation is not permitted');
        }
        signal?.throwIfAborted();
        return await registry.prepare(request.chatId, source, request.bytes, signal);
    }
    throw new Error('File preparation conversation not found');
}
