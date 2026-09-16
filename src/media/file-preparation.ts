import type {BackendController} from '../threema/backend-controller.ts';
import type {MediaRequest} from '../outbox/media-journal.ts';
import {parsePreparedFileSend} from '../threema/prepared-file-send.ts';
import {downloadAttachment} from './download-attachment.ts';

/** SDK discovery is not cancellable, but must not hold shutdown or trigger a later download. */
export async function preparationLimit(
    discover: () => Promise<number>,
    signal?: AbortSignal,
): Promise<number> {
    signal?.throwIfAborted();
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Media limit discovery interrupted'));
    });
    const timer = setTimeout(abort, 60000);
    signal?.addEventListener('abort', abort, {once: true});
    try {
        return await Promise.race([discover(), stopped]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/** Bridge-local download followed by bounded worker storage. One instance per profile dispatcher. */
export function createFilePreparation(options: {
    client: Parameters<typeof downloadAttachment>[0];
    userId: string;
    directory: string;
    maximumBytes: () => Promise<number>;
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
    backend: Pick<BackendController, 'prepareFile' | 'discardPreparedFile'>;
    signal?: AbortSignal;
}) {
    const cleanup = new Map<string, () => Promise<void>>();
    const active = new Set<string>();
    return async (value: MediaRequest) => {
        const request = structuredClone(value);
        if (request.media.kind !== 'm.file') throw new Error('Unsupported file preparation');
        if (active.has(request.id)) throw new Error('File preparation already running');
        active.add(request.id);
        try {
            options.signal?.throwIfAborted();
            const old = cleanup.get(request.id);
            if (old) {
                await old();
                cleanup.delete(request.id);
            }
            const maxBytes = await preparationLimit(options.maximumBytes, options.signal);
            options.signal?.throwIfAborted();
            const attachment = await downloadAttachment(
                options.client,
                options.userId,
                request.media.file.url,
                options.directory,
                {
                    bytes: request.media.bytes,
                    maxBytes,
                    mimeType: request.media.mimeType,
                    file: request.media.file,
                    verifyMime: options.verifyMime,
                    signal: options.signal,
                },
            );
            let token: string | undefined;
            const discard = async () => {
                if (token !== undefined) {
                    await options.backend.discardPreparedFile({
                        profile: request.profile,
                        chatId: request.media.chat,
                        token,
                    });
                    token = undefined;
                }
                await attachment.dispose();
            };
            cleanup.set(request.id, discard);
            try {
                token = await options.backend.prepareFile(
                    {profile: request.profile, chatId: request.media.chat, bytes: attachment.bytes},
                    attachment.stream(),
                    options.signal,
                );
                options.signal?.throwIfAborted();
                await attachment.dispose();
                const prepared = parsePreparedFileSend({
                    profile: request.profile,
                    chatId: request.media.chat,
                    token,
                    fileName: request.media.filename,
                    mediaType: request.media.mimeType,
                    ...(request.media.caption === undefined
                        ? {}
                        : {caption: request.media.caption}),
                });
                cleanup.delete(request.id);
                return {request: prepared, discard};
            } catch {
                try {
                    await discard();
                    cleanup.delete(request.id);
                } catch {
                    /* Retry retained cleanup before preparing this request again. */
                }
                throw new Error('File preparation failed');
            }
        } finally {
            active.delete(request.id);
        }
    };
}
