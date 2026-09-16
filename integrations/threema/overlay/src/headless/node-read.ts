import {hexLeToU64} from '@threema/ts-utils/number/hex-le-to-u64';
import type {BackendHandle} from '~/common/dom/backend';
import {ConnectionState, GroupUserState, ReceiverType} from '~/common/enum';
import {ensureMessageId} from '~/common/network/types';
import type {RemoteProxy} from '~/common/utils/endpoint';
import {nodeChatId} from './node-conversations';

/** Read through an existing native target; upstream handles privacy policy and device reflection. */
export async function markNodeRead(
    handle: RemoteProxy<BackendHandle>,
    request: {profile: string; chatId: string; messageId: string},
): Promise<void> {
    if (
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(request.profile) ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(request.chatId) ||
        !/^m:[0-9a-f]{16}$/.test(request.messageId)
    )
        throw new Error('Invalid read command');
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) throw new Error('Read profile mismatch');
    const connection = await handle.connectionManager.state;
    if (connection.get() !== ConnectionState.CONNECTED)
        throw new Error('Read connection unavailable');
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) continue;
        if (
            receiver.type === ReceiverType.GROUP &&
            receiver.view.userState !== GroupUserState.MEMBER
        )
            throw new Error('Read group membership unavailable');
        const id = ensureMessageId(hexLeToU64(request.messageId.slice(2)));
        if (!(await conversation.controller.getMessage(id)))
            throw new Error('Read target unavailable');
        if (connection.get() !== ConnectionState.CONNECTED)
            throw new Error('Read connection unavailable');
        await conversation.controller.read.fromLocal(new Date(), id);
        return;
    }
    throw new Error('Read conversation unavailable');
}
