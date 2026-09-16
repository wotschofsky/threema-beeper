import type {BackendHandle} from '~/common/dom/backend';
import {ConnectionState, ReceiverType} from '~/common/enum';
import type {RemoteProxy} from '~/common/utils/endpoint';
import {nodeChatId} from './node-conversations';
import {parseTypingCommand, type NodeTypingRequest} from './node-typing-request';

/** Use upstream privacy policy, coalescing and auto-expiry without persisting bridge typing state. */
export async function setNodeTyping(
    handle: RemoteProxy<BackendHandle>,
    value: NodeTypingRequest,
): Promise<void> {
    const request = parseTypingCommand(value);
    const identity = await handle.model.user.identity;
    if (identity !== request.profile) throw new Error('Typing profile mismatch');
    const connection = await handle.connectionManager.state;
    if (connection.get() !== ConnectionState.CONNECTED)
        throw new Error('Typing connection unavailable');
    const conversations = await handle.model.conversations.getAll();
    for (const store of conversations.get()) {
        const conversation = store.get();
        const receiver = (await conversation.controller.receiver()).get();
        if (nodeChatId(receiver, identity) !== request.chatId) continue;
        if (receiver.type !== ReceiverType.CONTACT)
            throw new Error('Typing unsupported for this conversation');
        if (connection.get() !== ConnectionState.CONNECTED)
            throw new Error('Typing connection unavailable');
        await conversation.controller.updateTyping.fromLocal(request.typing);
        return;
    }
    throw new Error('Typing conversation unavailable');
}
