import type {prepareOutboundAttachment} from './outbound-attachment.ts';
import {inspectVideoSource} from './video-inspector.ts';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';
import {prepareGeneratedAttachment} from './generated-attachment.ts';
import {prepareStaticImage} from './image-codec.ts';

export class VideoThumbnailCleanupError extends Error {}
/** Caller retains the verified video. Frame and first JPEG remain provisional ciphertext only. */
export async function prepareVideoThumbnail(
    source: Awaited<ReturnType<typeof prepareOutboundAttachment>>,
    directory: string,
    options: {
        codec: Omit<CodecProcessOptions, 'args' | 'allowEarlyInputClose'>;
        inspection: Parameters<typeof inspectVideoSource>[1];
        jpegExecutable: string;
        maximumThumbnailBytes: number;
    },
) {
    type Image = Awaited<
        ReturnType<
            typeof prepareGeneratedAttachment<Awaited<ReturnType<typeof prepareStaticImage>>>
        >
    >;
    let frame: Awaited<ReturnType<typeof prepareGeneratedAttachment<{bytes: number}>>> | undefined;
    let first: Image | undefined, thumbnail: Image | undefined;
    const codec = {...options.codec},
        inspection = {...options.inspection, thumbnail: true};
    const signals = [codec.signal, inspection.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.length) codec.signal = inspection.signal = AbortSignal.any(signals);
    try {
        if (
            !Number.isSafeInteger(source.bytes) ||
            source.bytes < 1 ||
            source.bytes > codec.maximumInputBytes ||
            !Number.isSafeInteger(options.maximumThumbnailBytes) ||
            options.maximumThumbnailBytes < 1 ||
            options.maximumThumbnailBytes > codec.maximumOutputBytes
        )
            throw new Error('Invalid video thumbnail limits');
        codec.signal?.throwIfAborted();
        const metadata = await inspectVideoSource(source, inspection);
        const selected = metadata.thumbnail!;
        const primary = metadata.tracks[selected.trackIndex]!;
        if (primary.type !== 'video') throw new Error('Invalid thumbnail track');
        const maximumFrameBytes = Math.min(
            codec.maximumOutputBytes,
            primary.width * primary.height * 4 + 512,
        );
        frame = await prepareGeneratedAttachment(
            async (output) => {
                const result = await runCodecProcess(source.stream(), output, {
                    ...codec,
                    maximumOutputBytes: maximumFrameBytes,
                    allowEarlyInputClose: true,
                    args: [
                        '-hide_banner',
                        '-loglevel',
                        'error',
                        '-nostdin',
                        '-xerror',
                        '-max_alloc',
                        '134217728',
                        '-protocol_whitelist',
                        'pipe',
                        '-threads',
                        '1',
                        '-filter_threads',
                        '1',
                        '-err_detect',
                        'explode',
                        '-copyts',
                        '-i',
                        'pipe:0',
                        '-map',
                        '0:v:0',
                        '-an',
                        '-vf',
                        `select=gte(t\\,${selected.timestamp - 0.000001}),scale=flags=bilinear+accurate_rnd+full_chroma_int`,
                        '-frames:v',
                        '1',
                        '-c:v',
                        'pam',
                        '-pix_fmt',
                        'rgba',
                        '-threads',
                        '1',
                        '-f',
                        'image2pipe',
                        'pipe:1',
                    ],
                });
                if (result.inputBytes !== source.bytes)
                    throw new Error('Video thumbnail source size mismatch');
                return {bytes: result.outputBytes};
            },
            directory,
            {
                maximumBytes: maximumFrameBytes,
                mimeType: 'image/x-portable-arbitrarymap',
                signal: codec.signal,
                verifyMime: async (prefix) => {
                    if (prefix.toString('ascii', 0, 3) !== 'P7\n')
                        throw new Error('Invalid extracted frame');
                },
            },
        );
        const jpeg = async (
            attachment: Awaited<ReturnType<typeof prepareOutboundAttachment>>,
            mimeType: 'image/x-portable-arbitrarymap' | 'image/jpeg',
            maximumSide: number,
            maximumOutputBytes: number,
        ) =>
            prepareGeneratedAttachment(
                (output) =>
                    prepareStaticImage(attachment.stream(), output, {
                        ...codec,
                        maximumInputBytes: attachment.bytes,
                        maximumOutputBytes,
                        mimeType,
                        outputMimeType: 'image/jpeg',
                        maximumSide,
                        maximumPixels: 100000000,
                        jpegExecutable: options.jpegExecutable,
                        jpegQuality: 80,
                    }),
                directory,
                {
                    maximumBytes: maximumOutputBytes,
                    mimeType: 'image/jpeg',
                    signal: codec.signal,
                    verifyMime: async (prefix) => {
                        if (
                            prefix.length < 3 ||
                            prefix[0] !== 255 ||
                            prefix[1] !== 216 ||
                            prefix[2] !== 255
                        )
                            throw new Error('Invalid video thumbnail JPEG');
                    },
                },
            );
        first = await jpeg(
            frame.attachment,
            'image/x-portable-arbitrarymap',
            8192,
            codec.maximumOutputBytes,
        );
        if (first.metadata.width !== primary.width || first.metadata.height !== primary.height)
            throw new Error('Video thumbnail geometry changed');
        thumbnail = await jpeg(first.attachment, 'image/jpeg', 512, options.maximumThumbnailBytes);
        await Promise.all([frame.attachment.dispose(), first.attachment.dispose()]);
        frame = undefined;
        first = undefined;
        codec.signal?.throwIfAborted();
        return thumbnail;
    } catch {
        const cleaned = await Promise.allSettled([
            frame?.attachment.dispose(),
            first?.attachment.dispose(),
            thumbnail?.attachment.dispose(),
        ]);
        if (cleaned.some((result) => result.status === 'rejected'))
            throw new VideoThumbnailCleanupError('Video thumbnail cleanup failed');
        throw new Error('Video thumbnail preparation failed');
    }
}
