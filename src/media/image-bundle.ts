import type {prepareOutboundAttachment} from './outbound-attachment.ts';
import {prepareStaticImage} from './image-codec.ts';
import {prepareGeneratedAttachment} from './generated-attachment.ts';

type ImageMetadata = Awaited<ReturnType<typeof prepareStaticImage>>;
type PreparedImage = Awaited<ReturnType<typeof prepareGeneratedAttachment<ImageMetadata>>>;

/** Main image and thumbnail share one lifetime; neither is sendable until both are complete. */
export async function prepareImageBundle(
    source: Pick<
        Awaited<ReturnType<typeof prepareOutboundAttachment>>,
        'stream' | 'bytes' | 'dispose'
    >,
    directory: string,
    options: Parameters<typeof prepareStaticImage>[2] & {
        thumbnailSide: number;
        maximumThumbnailBytes: number;
    },
): Promise<{image: PreparedImage; thumbnail: PreparedImage; dispose(): Promise<void>}> {
    let image: PreparedImage | undefined, thumbnail: PreparedImage | undefined;
    const dispose = async () => {
        const results = await Promise.allSettled([
            image?.attachment.dispose(),
            thumbnail?.attachment.dispose(),
        ]);
        if (results.some((result) => result.status === 'rejected'))
            throw new Error('Image bundle cleanup failed');
    };
    try {
        if (
            !Number.isSafeInteger(options.thumbnailSide) ||
            options.thumbnailSide < 1 ||
            options.thumbnailSide > 512 ||
            !Number.isSafeInteger(options.maximumThumbnailBytes) ||
            options.maximumThumbnailBytes < 1 ||
            options.maximumThumbnailBytes > options.maximumOutputBytes
        )
            throw new Error('Invalid thumbnail configuration');
        const mimeType = options.outputMimeType ?? 'image/png';
        const verifyMime = async (header: Buffer) => {
            const valid =
                mimeType === 'image/png'
                    ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                    : header.length >= 3 &&
                      header[0] === 0xff &&
                      header[1] === 0xd8 &&
                      header[2] === 0xff;
            if (!valid) throw new Error('Invalid generated image');
        };
        image = await prepareGeneratedAttachment(
            (output) => prepareStaticImage(source.stream(), output, {...options, jpegQuality: 85}),
            directory,
            {
                maximumBytes: options.maximumOutputBytes,
                mimeType,
                signal: options.signal,
                verifyMime,
            },
        );
        options.signal?.throwIfAborted();
        // Desktop independently resizes the original for both outputs.
        thumbnail = await prepareGeneratedAttachment(
            (output) =>
                prepareStaticImage(source.stream(), output, {
                    ...options,
                    jpegQuality: 80,
                    maximumSide: options.thumbnailSide,
                    maximumInputBytes: source.bytes,
                    maximumOutputBytes: options.maximumThumbnailBytes,
                }),
            directory,
            {
                maximumBytes: options.maximumThumbnailBytes,
                mimeType,
                signal: options.signal,
                verifyMime,
            },
        );
        options.signal?.throwIfAborted();
        await source.dispose();
        options.signal?.throwIfAborted();
        return {image, thumbnail, dispose};
    } catch {
        const results = await Promise.allSettled([dispose(), source.dispose()]);
        if (results.some((result) => result.status === 'rejected'))
            throw new Error('Image bundle cleanup failed');
        throw new Error('Image bundle preparation failed');
    }
}
