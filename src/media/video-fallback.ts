import {prepareVideoThumbnail, VideoThumbnailCleanupError} from './video-thumbnail.ts';
import {prepareVideoAttachment, VideoPreparationCleanupError} from './video-preparation.ts';

type Source = Parameters<typeof prepareVideoAttachment>[0];
type Options = Parameters<typeof prepareVideoAttachment>[2] & {
    thumbnail?: Pick<
        Parameters<typeof prepareVideoThumbnail>[2],
        'jpegExecutable' | 'maximumThumbnailBytes'
    >;
};
type Encoded = Awaited<ReturnType<typeof prepareVideoAttachment>>;
export type PreparedVideoFallback =
    | {
          encoding: 'avc';
          prepared: Encoded;
          thumbnail?: Awaited<ReturnType<typeof prepareVideoThumbnail>>;
      }
    | {
          encoding: 'original';
          prepared: {attachment: Source; metadata: {mimeType: string; bytes: number}};
      };

/** Conversion borrows the authenticated source; only successful handoff transfers ownership. */
export async function prepareVideoWithFallback(
    source: Source,
    directory: string,
    options: Options,
    sourceMimeType: string,
): Promise<PreparedVideoFallback> {
    options = {
        codec: {...options.codec},
        inspection: {...options.inspection},
        ...(options.thumbnail ? {thumbnail: {...options.thumbnail}} : {}),
    };
    let encoded: Encoded | undefined;
    let thumbnail: Awaited<ReturnType<typeof prepareVideoThumbnail>> | undefined;
    const checkCancellation = () => {
        options.codec.signal?.throwIfAborted();
        options.inspection.signal?.throwIfAborted();
    };
    try {
        if (
            ![options.codec.maximumInputBytes, options.codec.maximumOutputBytes].every(
                (limit) => Number.isSafeInteger(limit) && limit >= 1 && limit <= 1024 ** 3,
            ) ||
            !/^video\/[a-zA-Z0-9!#$&^_.+-]+$/.test(sourceMimeType) ||
            !Number.isSafeInteger(source.bytes) ||
            source.bytes < 1 ||
            source.bytes > options.codec.maximumInputBytes
        )
            throw new Error('Invalid video fallback source');
        checkCancellation();
        const borrowed: Source = {
            bytes: source.bytes,
            read: (start, end) => source.read(start, end),
            stream: () => source.stream(),
            dispose: async () => {},
        };
        if (options.thumbnail) {
            try {
                thumbnail = await prepareVideoThumbnail(borrowed, directory, {
                    ...options,
                    ...options.thumbnail,
                });
            } catch (error) {
                checkCancellation();
                if (error instanceof VideoThumbnailCleanupError) throw error;
                // Desktop permits a video without a thumbnail when extraction fails.
            }
        }
        checkCancellation();
        try {
            encoded = await prepareVideoAttachment(borrowed, directory, options);
        } catch (error) {
            checkCancellation();
            if (error instanceof VideoPreparationCleanupError) throw error;
        }
        checkCancellation();
        if (encoded) {
            await source.dispose();
            checkCancellation();
            return {encoding: 'avc', prepared: encoded, ...(thumbnail ? {thumbnail} : {})};
        }
        if (source.bytes > options.codec.maximumOutputBytes)
            throw new Error('Original video exceeds output limit');
        await thumbnail?.attachment.dispose();
        thumbnail = undefined;
        checkCancellation();
        return {
            encoding: 'original',
            prepared: {
                attachment: source,
                metadata: {mimeType: sourceMimeType, bytes: source.bytes},
            },
        };
    } catch {
        const cleaned = await Promise.allSettled([
            encoded?.attachment.dispose(),
            thumbnail?.attachment.dispose(),
            source.dispose(),
        ]);
        if (cleaned.some((result) => result.status === 'rejected'))
            throw new VideoPreparationCleanupError('Video fallback cleanup failed');
        throw new Error('Video fallback failed');
    }
}
