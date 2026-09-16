import type {BackendController} from '../threema/backend-controller.ts';
import type {MediaRequest} from '../outbox/media-journal.ts';
import {parseAudioProjection} from '../outbox/audio-projection.ts';
import {parsePreparedFileSend} from '../threema/prepared-file-send.ts';
import {downloadAttachment} from './download-attachment.ts';
import {preparationLimit} from './file-preparation.ts';
import {prepareAudioAttachment} from './audio-preparation.ts';
import {prepareAudioWithFallback} from './audio-fallback.ts';

/** One instance per profile: authenticated audio -> AAC/Opus/original -> opaque worker token. */
export function createAudioPreparation(options: {
    client: Parameters<typeof downloadAttachment>[0];
    userId: string;
    directory: string;
    maximumBytes: () => Promise<number>;
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
    backend: Pick<BackendController, 'prepareFile' | 'discardPreparedFile'>;
    codec: Omit<
        Parameters<typeof prepareAudioAttachment>[2],
        'maximumInputBytes' | 'maximumOutputBytes' | 'signal'
    >;
    signal?: AbortSignal;
}) {
    const cleanup = new Map<string, () => Promise<void>>(),
        active = new Set<string>();
    return async (value: MediaRequest) => {
        const request = structuredClone(value),
            media = request.media;
        if (
            media.kind !== 'm.audio' ||
            media.replyTo !== undefined ||
            !media.mimeType.startsWith('audio/')
        )
            throw new Error('Unsupported audio preparation');
        if (active.has(request.id)) throw new Error('Audio preparation already running');
        active.add(request.id);
        let source: Awaited<ReturnType<typeof downloadAttachment>> | undefined;
        let encoded: Awaited<ReturnType<typeof prepareAudioWithFallback>>['prepared'] | undefined;
        let token: string | undefined;
        const discard = async () => {
            const results = await Promise.allSettled([
                (async () => {
                    if (token !== undefined) {
                        await options.backend.discardPreparedFile({
                            profile: request.profile,
                            chatId: media.chat,
                            token,
                        });
                        token = undefined;
                    }
                })(),
                encoded?.attachment.dispose(),
                source?.dispose(),
            ]);
            if (results.some((result) => result.status === 'rejected'))
                throw new Error('Audio staging cleanup failed');
        };
        try {
            options.signal?.throwIfAborted();
            const previous = cleanup.get(request.id);
            if (previous) {
                await previous();
                cleanup.delete(request.id);
            }
            const maximumBytes = await preparationLimit(options.maximumBytes, options.signal);
            source = await downloadAttachment(
                options.client,
                options.userId,
                media.file.url,
                options.directory,
                {
                    bytes: media.bytes,
                    maxBytes: maximumBytes,
                    mimeType: media.mimeType,
                    file: media.file,
                    signal: options.signal,
                    verifyMime: options.verifyMime,
                },
            );
            cleanup.set(request.id, discard);
            const converted = await prepareAudioWithFallback(
                source,
                options.directory,
                {
                    ...options.codec,
                    maximumInputBytes: maximumBytes,
                    maximumOutputBytes: maximumBytes,
                    signal: options.signal,
                },
                media.mimeType,
            );
            encoded = converted.prepared;
            source = undefined;
            const projection = parseAudioProjection({
                kind: converted.encoding === 'aac' ? 'audio' : 'file',
                fileName:
                    converted.encoding === 'original'
                        ? media.filename
                        : `threema-${Date.now()}.m4a`,
                mediaType: encoded.metadata.mimeType,
                bytes: encoded.metadata.bytes,
                ...(converted.encoding === 'aac'
                    ? {durationSeconds: converted.prepared.metadata.durationSeconds}
                    : {}),
                ...(media.caption === undefined ? {} : {caption: media.caption}),
            });
            options.signal?.throwIfAborted();
            token = await options.backend.prepareFile(
                {profile: request.profile, chatId: media.chat, bytes: encoded.attachment.bytes},
                encoded.attachment.stream(),
                options.signal,
            );
            options.signal?.throwIfAborted();
            const command = parsePreparedFileSend({
                profile: request.profile,
                chatId: media.chat,
                token,
                fileName: projection.fileName,
                mediaType: projection.mediaType,
                ...(projection.kind === 'audio'
                    ? {audioDurationSeconds: projection.durationSeconds}
                    : {}),
                ...(projection.caption === undefined ? {} : {caption: projection.caption}),
            });
            await encoded.attachment.dispose();
            options.signal?.throwIfAborted();
            cleanup.delete(request.id);
            return {request: command, projection, discard};
        } catch {
            // A prior cleanup failure must remain registered; do not replace it with this empty attempt.
            if (cleanup.get(request.id) === discard) {
                try {
                    await discard();
                    cleanup.delete(request.id);
                } catch {
                    /* Retry before the next attempt. */
                }
            }
            throw new Error('Audio staging failed');
        } finally {
            active.delete(request.id);
        }
    };
}
