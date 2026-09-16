import type {prepareOutboundAttachment} from './outbound-attachment.ts';
import {prepareAvifImage} from './avif-image.ts';
import {prepareDecodedImage} from './decoded-image.ts';
import {prepareGeneratedAttachment} from './generated-attachment.ts';

type Metadata = Awaited<ReturnType<typeof prepareAvifImage>>;
type Prepared = Awaited<ReturnType<typeof prepareGeneratedAttachment<Metadata>>>;

/** Owns the verified source; both outputs remain provisional until source cleanup succeeds. */
export async function prepareAvifBundle(
    source: Awaited<ReturnType<typeof prepareOutboundAttachment>>,
    directory: string,
    options: Omit<Parameters<typeof prepareAvifImage>[2], 'inputBytes'> & {
        thumbnailSide: number;
        maximumThumbnailBytes: number;
    },
): Promise<{image: Prepared; thumbnail: Prepared; dispose(): Promise<void>}> {
    let image: Prepared | undefined, thumbnail: Prepared | undefined;
    const dispose = async () => {
        const results = await Promise.allSettled([
            image?.attachment.dispose(),
            thumbnail?.attachment.dispose(),
        ]);
        if (results.some((result) => result.status === 'rejected'))
            throw new Error('AVIF bundle cleanup failed');
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
            throw new Error('Invalid AVIF thumbnail configuration');
        image = await prepareGeneratedAttachment(
            (output) =>
                prepareAvifImage(source.stream(), output, {...options, inputBytes: source.bytes}),
            directory,
            {
                maximumBytes: options.maximumOutputBytes,
                mimeType: 'image/png',
                signal: options.signal,
                verifyMime: async (header) => {
                    if (
                        !header
                            .subarray(0, 8)
                            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                    )
                        throw new Error('Invalid AVIF main output');
                },
            },
        );
        options.signal?.throwIfAborted();
        // Desktop derives the thumbnail independently from the original, before main resizing.
        thumbnail = await prepareGeneratedAttachment(
            (output) =>
                prepareDecodedImage(source.stream(), output, {
                    ...options,
                    outputMimeType: 'image/jpeg',
                    jpegQuality: 80,
                    decoderExecutable: options.avifExecutable,
                    decoderArgs: ['33554432', String(options.maximumPixels), String(source.bytes)],
                    expectedInputBytes: source.bytes,
                    maximumSide: options.thumbnailSide,
                    maximumOutputBytes: options.maximumThumbnailBytes,
                }),
            directory,
            {
                maximumBytes: options.maximumThumbnailBytes,
                mimeType: 'image/jpeg',
                signal: options.signal,
                verifyMime: async (header) => {
                    if (
                        header.length < 3 ||
                        header[0] !== 255 ||
                        header[1] !== 216 ||
                        header[2] !== 255
                    )
                        throw new Error('Invalid AVIF thumbnail output');
                },
            },
        );
        options.signal?.throwIfAborted();
        await source.dispose();
        options.signal?.throwIfAborted();
        return {image, thumbnail, dispose};
    } catch {
        const results = await Promise.allSettled([dispose(), source.dispose()]);
        if (results.some((result) => result.status === 'rejected'))
            throw new Error('AVIF bundle cleanup failed');
        throw new Error('AVIF bundle preparation failed');
    }
}
