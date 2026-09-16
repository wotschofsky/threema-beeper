import type {BackendController} from '../threema/backend-controller.ts';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import type {MediaDescriptor} from './media-renderer.ts';

/** Metadata is obtained first; opening the bounded stream is deferred until an upload is needed. */
export async function describeBackendMedia(
    backend: Pick<BackendController, 'mediaInfo' | 'mediaStream'>,
    message: NormalizedNodeMessage,
    part: 'file' | 'thumbnail',
    maximumBytes: number,
    signal?: AbortSignal,
): Promise<MediaDescriptor> {
    signal?.throwIfAborted();
    const request = {chatId: message.chatId, messageId: message.messageId, part, maximumBytes};
    const info = await backend.mediaInfo(request);
    signal?.throwIfAborted();
    return {...info, open: () => backend.mediaStream(request, info, signal)};
}
