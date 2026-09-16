import type {MediaRequest} from '../outbox/media-journal.ts';
import {downloadAttachment} from './download-attachment.ts';
import {preparationLimit} from './file-preparation.ts';
import {prepareVideoWithFallback} from './video-fallback.ts';
import {createVideoStaging} from './video-staging.ts';

type ConversionOptions = Parameters<typeof prepareVideoWithFallback>[2];

/** One authenticated download per attempt; conversion and thumbnail share the verified source. */
export function createVideoPreparation(options: {
    client: Parameters<typeof downloadAttachment>[0];
    userId: string;
    directory: string;
    maximumBytes: () => Promise<number>;
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
    backend: Parameters<typeof createVideoStaging>[0];
    codec: Omit<ConversionOptions['codec'], 'maximumInputBytes' | 'maximumOutputBytes' | 'signal'>;
    inspection: Omit<ConversionOptions['inspection'], 'signal'>;
    thumbnail?: ConversionOptions['thumbnail'];
    signal?: AbortSignal;
}) {
    const stage = createVideoStaging(options.backend);
    const active = new Set<string>();
    const cleanup = new Map<string, () => Promise<void>>();
    return async (value: MediaRequest) => {
        const request = structuredClone(value),
            media = request.media;
        if (
            media.kind !== 'm.video' ||
            media.replyTo !== undefined ||
            !media.mimeType.startsWith('video/')
        )
            throw new Error('Unsupported video preparation');
        if (active.has(request.id)) throw new Error('Video preparation already running');
        active.add(request.id);
        const clearSource = async () => {
            await cleanup.get(request.id)?.();
            cleanup.delete(request.id);
        };
        try {
            options.signal?.throwIfAborted();
            await clearSource();
            await stage.clearPending(request.id);
            const maximumBytes = await preparationLimit(options.maximumBytes, options.signal);
            options.signal?.throwIfAborted();
            const source = await downloadAttachment(
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
            cleanup.set(request.id, () => source.dispose());
            const bundle = await prepareVideoWithFallback(
                source,
                options.directory,
                {
                    codec: {
                        ...options.codec,
                        maximumInputBytes: maximumBytes,
                        maximumOutputBytes: maximumBytes,
                        signal: options.signal,
                    },
                    inspection: {...options.inspection, signal: options.signal},
                    ...(options.thumbnail ? {thumbnail: {...options.thumbnail}} : {}),
                },
                media.mimeType,
            );
            // The bundle now owns the original or converted source. Staging retains failed cleanup.
            cleanup.delete(request.id);
            return await stage(
                {
                    id: request.id,
                    profile: request.profile,
                    chatId: media.chat,
                    fileName: media.filename,
                    ...(media.caption === undefined ? {} : {caption: media.caption}),
                },
                bundle,
                options.signal,
            );
        } catch {
            try {
                await clearSource();
            } catch {
                /* Retain the source before allowing another download. */
            }
            throw new Error('Video preparation failed');
        } finally {
            active.delete(request.id);
        }
    };
}
