import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {EncryptedFile} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/models/events/MessageEvent.js';
import type {PreparedAttachment} from './encrypted-attachment.ts';

/** Uploads only ciphertext. Caller persists the returned key/URL privately, then disposes the spool. */
export async function uploadAttachment(
    client: Pick<MatrixClient, 'doRequest'>,
    attachment: PreparedAttachment,
    signal?: AbortSignal,
): Promise<EncryptedFile> {
    signal?.throwIfAborted();
    const stream = attachment.stream();
    const abort = () => stream.destroy(new Error('Attachment upload cancelled'));
    signal?.addEventListener('abort', abort, {once: true});
    try {
        const response = await client.doRequest(
            'POST',
            '/_matrix/media/v3/upload',
            null,
            stream,
            60000,
            false,
            'application/octet-stream',
        );
        signal?.throwIfAborted();
        if (
            typeof response?.content_uri !== 'string' ||
            !/^mxc:\/\/[^\s/?#]+\/[^\s/?#]+$/.test(response.content_uri)
        )
            throw new Error('Invalid Matrix upload response');
        return {...attachment.file, url: response.content_uri};
    } finally {
        signal?.removeEventListener('abort', abort);
        stream.destroy();
    }
}
