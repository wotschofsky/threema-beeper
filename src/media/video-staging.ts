import type {BackendController} from '../threema/backend-controller.ts';
import {parsePreparedFileSend} from '../threema/prepared-file-send.ts';
import {parsePreparedVideoSend} from '../threema/prepared-video-send.ts';
import {parseVideoProjection} from '../outbox/video-projection.ts';
import type {PreparedVideoFallback} from './video-fallback.ts';

/** One instance per profile; retain every failed token/spool cleanup before allowing a retry. */
export function createVideoStaging(
    backend: Pick<BackendController, 'prepareFile' | 'discardPreparedFile'>,
) {
    const cleanup = new Map<string, Set<() => Promise<void>>>();
    const active = new Set<string>();
    const clearPending = async (id: string) => {
        for (const previous of [...(cleanup.get(id) ?? [])]) await previous();
    };
    const stage = async (
        value: {id: string; profile: string; chatId: string; fileName: string; caption?: string},
        bundle: PreparedVideoFallback,
        signal?: AbortSignal,
    ) => {
        const source = {...value};
        const attachment = bundle.prepared.attachment;
        const metadata = {...bundle.prepared.metadata};
        const encoding = bundle.encoding;
        const thumbnail =
            bundle.encoding === 'avc' && bundle.thumbnail
                ? {
                      metadata: {...bundle.thumbnail.metadata},
                      attachment: bundle.thumbnail.attachment,
                  }
                : undefined;
        const attachments = [
            ...new Set([attachment, ...(thumbnail ? [thumbnail.attachment] : [])]),
        ];
        const tokens = new Set<string>();
        const disposed = new Set<typeof attachment>();
        const remember = () => {
            let pending = cleanup.get(source.id);
            if (!pending) {
                pending = new Set();
                cleanup.set(source.id, pending);
            }
            pending.add(discard);
        };
        const discard = async () => {
            remember();
            const results = await Promise.allSettled([
                ...[...tokens].map(async (token) => {
                    await backend.discardPreparedFile({
                        profile: source.profile,
                        chatId: source.chatId,
                        token,
                    });
                    tokens.delete(token);
                }),
                ...attachments.map(async (part) => {
                    if (!disposed.has(part)) {
                        await part.dispose();
                        disposed.add(part);
                    }
                }),
            ]);
            if (results.some((result) => result.status === 'rejected'))
                throw new Error('Video staging cleanup pending');
            const pending = cleanup.get(source.id);
            pending?.delete(discard);
            if (pending?.size === 0) cleanup.delete(source.id);
        };
        if (active.has(source.id)) {
            await discard();
            throw new Error('Video staging already active');
        }
        active.add(source.id);
        try {
            signal?.throwIfAborted();
            await clearPending(source.id);
            if (
                thumbnail &&
                (thumbnail.attachment === attachment ||
                    thumbnail.metadata.bytes !== thumbnail.attachment.bytes)
            )
                throw new Error('Invalid video thumbnail attachment');
            const projection = parseVideoProjection({
                kind: encoding === 'avc' ? 'video' : 'file',
                fileName: encoding === 'original' ? source.fileName : `threema-${Date.now()}.mp4`,
                mediaType: metadata.mimeType,
                bytes: metadata.bytes,
                ...(thumbnail
                    ? {
                          thumbnailMediaType: thumbnail.metadata.mimeType,
                          thumbnailBytes: thumbnail.metadata.bytes,
                          thumbnailWidth: thumbnail.metadata.width,
                          thumbnailHeight: thumbnail.metadata.height,
                      }
                    : {}),
                ...(source.caption === undefined ? {} : {caption: source.caption}),
                ...(encoding === 'avc' && 'durationSeconds' in metadata
                    ? {
                          durationSeconds: metadata.durationSeconds,
                          width: metadata.width,
                          height: metadata.height,
                      }
                    : {}),
            });
            if (projection.bytes !== attachment.bytes)
                throw new Error('Video staging size conflict');
            const base = {
                profile: source.profile,
                chatId: source.chatId,
                fileName: projection.fileName,
                mediaType: projection.mediaType,
                token: 'a'.repeat(64),
                ...(projection.caption === undefined ? {} : {caption: projection.caption}),
            };
            const command =
                projection.kind === 'video'
                    ? parsePreparedVideoSend({
                          ...base,
                          durationSeconds: projection.durationSeconds,
                          width: projection.width,
                          height: projection.height,
                          ...(thumbnail
                              ? {
                                    thumbnailToken: 'b'.repeat(64),
                                    thumbnailMediaType: thumbnail.metadata.mimeType,
                                    thumbnailWidth: thumbnail.metadata.width,
                                    thumbnailHeight: thumbnail.metadata.height,
                                }
                              : {}),
                      })
                    : parsePreparedFileSend(base);
            remember();
            signal?.throwIfAborted();
            const token = await backend.prepareFile(
                {profile: command.profile, chatId: command.chatId, bytes: projection.bytes},
                attachment.stream(),
                signal,
            );
            tokens.add(token);
            command.token = token;
            if (thumbnail && 'durationSeconds' in command) {
                signal?.throwIfAborted();
                const thumbnailToken = await backend.prepareFile(
                    {
                        profile: command.profile,
                        chatId: command.chatId,
                        bytes: thumbnail.attachment.bytes,
                    },
                    thumbnail.attachment.stream(),
                    signal,
                );
                tokens.add(thumbnailToken);
                command.thumbnailToken = thumbnailToken;
            }
            signal?.throwIfAborted();
            const parsed =
                projection.kind === 'video'
                    ? parsePreparedVideoSend(command)
                    : parsePreparedFileSend(command);
            const closed = await Promise.allSettled(
                attachments.map(async (part) => {
                    await part.dispose();
                    disposed.add(part);
                }),
            );
            if (closed.some((result) => result.status === 'rejected'))
                throw new Error('Video staging spool cleanup failed');
            signal?.throwIfAborted();
            const pending = cleanup.get(source.id);
            pending?.delete(discard);
            if (pending?.size === 0) cleanup.delete(source.id);
            return {request: parsed, projection, discard};
        } catch {
            try {
                await discard();
            } catch {
                /* Retained for the next attempt. */
            }
            throw new Error('Video staging failed');
        } finally {
            active.delete(source.id);
        }
    };
    return Object.assign(stage, {clearPending});
}
