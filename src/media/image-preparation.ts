import {prepareAvifBundle} from './avif-bundle.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import type {MediaRequest} from '../outbox/media-journal.ts';
import {parseImageProjection} from '../outbox/image-projection.ts';
import {downloadAttachment} from './download-attachment.ts';
import {preparationLimit} from './file-preparation.ts';
import {prepareImageBundle} from './image-bundle.ts';
import {createImageStaging} from './image-staging.ts';
import {prepareRetainedImageBundle} from './retained-image-bundle.ts';

/** Authenticated source -> verified plaintext stream -> canonical encrypted bundle -> worker tokens. */
export function createImagePreparation(options: {
    client: Parameters<typeof downloadAttachment>[0];
    userId: string;
    directory: string;
    maximumBytes: () => Promise<number>;
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
    backend: Pick<BackendController, 'prepareFile' | 'discardPreparedFile'>;
    codec: Omit<
        Parameters<typeof prepareImageBundle>[2],
        'mimeType' | 'outputMimeType' | 'maximumInputBytes' | 'maximumOutputBytes' | 'signal'
    > & {webpExecutable?: string; avifExecutable?: string};
    signal?: AbortSignal;
}) {
    const stage = createImageStaging(options.backend);
    const active = new Set<string>();
    return async (value: MediaRequest) => {
        const request = structuredClone(value),
            media = request.media;
        if (
            media.kind !== 'm.image' ||
            !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(
                media.mimeType,
            )
        )
            throw new Error('Unsupported image preparation');
        if (active.has(request.id)) throw new Error('Image preparation already active');
        active.add(request.id);
        let source: Awaited<ReturnType<typeof downloadAttachment>> | undefined;
        let bundle:
            | Awaited<ReturnType<typeof prepareImageBundle>>
            | Awaited<ReturnType<typeof prepareRetainedImageBundle>>
            | undefined;
        try {
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
            const limits = {
                ...options.codec,
                maximumInputBytes: maximumBytes,
                maximumOutputBytes: maximumBytes,
                maximumThumbnailBytes: Math.min(options.codec.maximumThumbnailBytes, maximumBytes),
                signal: options.signal,
            };
            bundle =
                media.mimeType === 'image/avif'
                    ? await prepareAvifBundle(source, options.directory, {
                          ...limits,
                          avifExecutable:
                              options.codec.avifExecutable ?? '/usr/local/bin/avif-first-frame',
                      })
                    : media.mimeType === 'image/gif' || media.mimeType === 'image/webp'
                      ? await prepareRetainedImageBundle(source.stream(), options.directory, {
                            ...limits,
                            mimeType: media.mimeType,
                        })
                      : await prepareImageBundle(source, options.directory, {
                            ...limits,
                            mimeType: media.mimeType as 'image/png' | 'image/jpeg',
                            outputMimeType: media.mimeType as 'image/png' | 'image/jpeg',
                        });
            await source.dispose();
            source = undefined;
            const fileName = media.filename;
            const projection = parseImageProjection({
                kind: 'image',
                fileName,
                mediaType: bundle.image.metadata.mimeType,
                bytes: bundle.image.metadata.bytes,
                width: bundle.image.metadata.width,
                height: bundle.image.metadata.height,
                thumbnailMediaType: bundle.thumbnail.metadata.mimeType,
                thumbnailBytes: bundle.thumbnail.metadata.bytes,
                thumbnailWidth: bundle.thumbnail.metadata.width,
                thumbnailHeight: bundle.thumbnail.metadata.height,
                ...(media.caption === undefined ? {} : {caption: media.caption}),
            });
            const owned = bundle;
            bundle = undefined;
            const result = await stage(
                {
                    id: request.id,
                    profile: request.profile,
                    chatId: media.chat,
                    fileName,
                    ...(media.caption === undefined ? {} : {caption: media.caption}),
                },
                owned,
                options.signal,
            );
            return {...result, projection};
        } finally {
            const results = await Promise.allSettled([source?.dispose(), bundle?.dispose()]);
            active.delete(request.id);
            if (results.some((result) => result.status === 'rejected'))
                throw new Error('Image preparation cleanup failed');
        }
    };
}
