import {Transform, type Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {prepareGeneratedAttachment} from './generated-attachment.ts';
import {prepareStaticImage} from './image-codec.ts';
import {webpDimensions} from './webp-header.ts';
import {prepareWebpThumbnail} from './webp-thumbnail.ts';

/** Preserve GIF/WebP bytes while decoding a bounded first-frame JPEG thumbnail. */
export async function prepareRetainedImageBundle(
    source: Readable,
    directory: string,
    options: Omit<Parameters<typeof prepareStaticImage>[2], 'mimeType' | 'outputMimeType'> & {
        mimeType: 'image/gif' | 'image/webp';
        webpExecutable?: string;
        thumbnailSide: number;
        maximumThumbnailBytes: number;
    },
) {
    const mimeType = options.mimeType;
    type Main = {
        mimeType: 'image/gif' | 'image/webp';
        width: number;
        height: number;
        bytes: number;
    };
    type Thumbnail = Awaited<ReturnType<typeof prepareStaticImage>>;
    let image: Awaited<ReturnType<typeof prepareGeneratedAttachment<Main>>> | undefined;
    let thumbnail: Awaited<ReturnType<typeof prepareGeneratedAttachment<Thumbnail>>> | undefined;
    const dispose = async () => {
        const results = await Promise.allSettled([
            image?.attachment.dispose(),
            thumbnail?.attachment.dispose(),
        ]);
        if (results.some((result) => result.status === 'rejected'))
            throw new Error('Retained image cleanup failed');
    };
    try {
        if (
            !['image/gif', 'image/webp'].includes(mimeType) ||
            !Number.isSafeInteger(options.thumbnailSide) ||
            options.thumbnailSide < 1 ||
            options.thumbnailSide > 512 ||
            !Number.isSafeInteger(options.maximumThumbnailBytes) ||
            options.maximumThumbnailBytes < 1 ||
            options.maximumThumbnailBytes > options.maximumOutputBytes
        )
            throw new Error('Invalid retained image configuration');
        const header = Buffer.alloc(mimeType === 'image/gif' ? 10 : 65536);
        let length = 0,
            bytes = 0;
        const inspect = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                const copied = Math.min(header.length - length, chunk.length);
                chunk.copy(header, length, 0, copied);
                length += copied;
                bytes += chunk.length;
                callback(null, chunk);
            },
        });
        image = await prepareGeneratedAttachment(
            async (output): Promise<Main> => {
                await pipeline(source, inspect, output, {signal: options.signal});
                let width: number, height: number;
                if (mimeType === 'image/gif') {
                    const signature = header.toString('ascii', 0, 6);
                    if (length !== 10 || (signature !== 'GIF87a' && signature !== 'GIF89a'))
                        throw new Error('Invalid GIF header');
                    width = header.readUInt16LE(6);
                    height = header.readUInt16LE(8);
                } else {
                    ({width, height} = webpDimensions(header.subarray(0, length), bytes));
                }
                if (
                    !width ||
                    !height ||
                    width > 8192 ||
                    height > 8192 ||
                    width * height > options.maximumPixels
                )
                    throw new Error('Retained image dimensions exceed limits');
                return {mimeType, width, height, bytes};
            },
            directory,
            {
                maximumBytes: Math.min(options.maximumInputBytes, options.maximumOutputBytes),
                mimeType,
                signal: options.signal,
                verifyMime: async (prefix) => {
                    if (
                        mimeType === 'image/gif' &&
                        !['GIF87a', 'GIF89a'].includes(prefix.toString('ascii', 0, 6))
                    )
                        throw new Error('Invalid retained GIF');
                    if (
                        mimeType === 'image/webp' &&
                        (prefix.toString('ascii', 0, 4) !== 'RIFF' ||
                            prefix.toString('ascii', 8, 12) !== 'WEBP')
                    )
                        throw new Error('Invalid retained WebP');
                },
            },
        );
        thumbnail = await prepareGeneratedAttachment(
            (output) => {
                const limits = {
                    ...options,
                    jpegQuality: 80,
                    maximumSide: options.thumbnailSide,
                    maximumInputBytes: image!.metadata.bytes,
                    maximumOutputBytes: options.maximumThumbnailBytes,
                };
                return mimeType === 'image/webp'
                    ? prepareWebpThumbnail(image!.attachment.stream(), output, {
                          ...limits,
                          webpExecutable:
                              options.webpExecutable ?? '/usr/local/bin/webp-first-frame',
                      })
                    : prepareStaticImage(image!.attachment.stream(), output, {
                          ...limits,
                          mimeType,
                          outputMimeType: 'image/jpeg',
                      });
            },
            directory,
            {
                maximumBytes: options.maximumThumbnailBytes,
                mimeType: 'image/jpeg',
                signal: options.signal,
                verifyMime: async (prefix) => {
                    if (
                        prefix.length < 3 ||
                        prefix.readUInt16BE(0) !== 0xffd8 ||
                        prefix[2] !== 0xff
                    )
                        throw new Error('Invalid retained image thumbnail');
                },
            },
        );
        options.signal?.throwIfAborted();
        return {image, thumbnail, dispose};
    } catch {
        await dispose();
        throw new Error('Retained image preparation failed');
    } finally {
        source.destroy();
    }
}
