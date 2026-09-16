import {PassThrough, type Readable, type Writable} from 'node:stream';
import {runCodecProcess} from './codec-process.ts';
import {prepareStaticImage} from './image-codec.ts';

/** Composited RGBA pixels pass directly between limited processes, never through a disk file. */
export async function prepareDecodedImage(
    input: Readable,
    output: Writable,
    options: Omit<Parameters<typeof prepareStaticImage>[2], 'mimeType'> & {
        decoderExecutable: string;
        decoderArgs: readonly string[];
        expectedInputBytes?: number;
    },
) {
    if (
        !Number.isSafeInteger(options.maximumPixels) ||
        options.maximumPixels < 1 ||
        options.maximumPixels > 100000000 ||
        (options.expectedInputBytes !== undefined &&
            (!Number.isSafeInteger(options.expectedInputBytes) ||
                options.expectedInputBytes < 1 ||
                options.expectedInputBytes > options.maximumInputBytes))
    )
        throw new Error('Invalid decoded image configuration');
    const pixels = new PassThrough({highWaterMark: 65536});
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const maximumPixelBytes = options.maximumPixels * 4 + 256;
    const fail = (error: unknown): never => {
        abort.abort();
        pixels.destroy();
        throw error;
    };
    const decode = runCodecProcess(input, pixels, {
        ...options,
        signal,
        executable: options.decoderExecutable,
        args: options.decoderArgs,
        maximumOutputBytes: maximumPixelBytes,
        allowEarlyInputClose: true,
    }).catch(fail);
    const encode = prepareStaticImage(pixels, output, {
        ...options,
        signal,
        mimeType: 'image/x-portable-arbitrarymap',
        outputMimeType: options.outputMimeType ?? 'image/png',
        maximumInputBytes: maximumPixelBytes,
    }).catch(fail);
    const results = await Promise.allSettled([decode, encode]);
    pixels.destroy();
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled')
        throw new Error('Decoded image preparation failed');
    if (
        options.expectedInputBytes !== undefined &&
        results[0].value.inputBytes !== options.expectedInputBytes
    )
        throw new Error('Decoded image input size mismatch');
    return results[1].value;
}
