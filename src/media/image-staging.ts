import type {prepareRetainedImageBundle} from './retained-image-bundle.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import {parsePreparedImageSend} from '../threema/prepared-image-send.ts';
import type {prepareImageBundle} from './image-bundle.ts';

/** One instance per profile. Retain failed token cleanup so retries cannot strand known handles. */
export function createImageStaging(
    backend: Pick<BackendController, 'prepareFile' | 'discardPreparedFile'>,
) {
    const cleanup = new Map<string, () => Promise<void>>();
    const active = new Set<string>();
    return async (
        source: {id: string; profile: string; chatId: string; fileName: string; caption?: string},
        bundle:
            | Awaited<ReturnType<typeof prepareImageBundle>>
            | Awaited<ReturnType<typeof prepareRetainedImageBundle>>,
        signal?: AbortSignal,
    ) => {
        const request = {...source};
        if (active.has(request.id)) {
            await bundle.dispose();
            throw new Error('Image staging already active');
        }
        active.add(request.id);
        const tokens = new Set<string>();
        let disposed = false;
        const discard = async () => {
            const results = await Promise.allSettled(
                [...tokens].map(async (token) => {
                    await backend.discardPreparedFile({
                        profile: request.profile,
                        chatId: request.chatId,
                        token,
                    });
                    tokens.delete(token);
                }),
            );
            if (results.some((result) => result.status === 'rejected'))
                throw new Error('Image token cleanup pending');
        };
        try {
            signal?.throwIfAborted();
            await cleanup.get(request.id)?.();
            cleanup.delete(request.id);
            const command = parsePreparedImageSend({
                profile: request.profile,
                chatId: request.chatId,
                fileName: request.fileName,
                ...(request.caption === undefined ? {} : {caption: request.caption}),
                token: 'a'.repeat(64),
                thumbnailToken: 'b'.repeat(64),
                mediaType: bundle.image.metadata.mimeType,
                thumbnailMediaType: bundle.thumbnail.metadata.mimeType,
                width: bundle.image.metadata.width,
                height: bundle.image.metadata.height,
                thumbnailWidth: bundle.thumbnail.metadata.width,
                thumbnailHeight: bundle.thumbnail.metadata.height,
            });
            cleanup.set(request.id, discard);
            for (const [part, field] of [
                [bundle.image, 'token'],
                [bundle.thumbnail, 'thumbnailToken'],
            ] as const) {
                signal?.throwIfAborted();
                const token = await backend.prepareFile(
                    {
                        profile: command.profile,
                        chatId: command.chatId,
                        bytes: part.attachment.bytes,
                    },
                    part.attachment.stream(),
                    signal,
                );
                tokens.add(token);
                command[field] = token;
            }
            signal?.throwIfAborted();
            const parsed = parsePreparedImageSend(command);
            await bundle.dispose();
            disposed = true;
            cleanup.delete(request.id);
            return {request: parsed, discard};
        } catch {
            try {
                await discard();
                if (cleanup.get(request.id) === discard) cleanup.delete(request.id);
            } catch {
                /* Retry before staging this request again. */
            }
            throw new Error('Image staging failed');
        } finally {
            try {
                if (!disposed) await bundle.dispose();
            } finally {
                active.delete(request.id);
            }
        }
    };
}
