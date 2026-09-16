import {PassThrough, Transform, type Readable, type Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';

/** Static PNG/JPEG preparation. PNG preserves alpha; both formats remove source metadata. */
export async function prepareStaticImage(
    input: Readable,
    output: Writable,
    options: Omit<CodecProcessOptions, 'args'> & {
        mimeType:
            | 'image/png'
            | 'image/jpeg'
            | 'image/gif'
            | 'image/webp'
            | 'image/x-portable-arbitrarymap';
        outputMimeType?: 'image/png' | 'image/jpeg';
        jpegExecutable?: string;
        jpegQuality?: number;
        maximumSide: number;
        maximumPixels: number;
    },
): Promise<{mimeType: 'image/png' | 'image/jpeg'; width: number; height: number; bytes: number}> {
    const outputMimeType = options.outputMimeType ?? 'image/png';
    const quality = options.jpegQuality ?? 85;
    if (
        ![
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'image/x-portable-arbitrarymap',
        ].includes(options.mimeType) ||
        !['image/png', 'image/jpeg'].includes(outputMimeType) ||
        !Number.isSafeInteger(quality) ||
        quality < 0 ||
        quality > 100 ||
        !Number.isSafeInteger(options.maximumSide) ||
        options.maximumSide < 1 ||
        options.maximumSide > 8192 ||
        !Number.isSafeInteger(options.maximumPixels) ||
        options.maximumPixels < 1 ||
        options.maximumPixels > 100000000
    )
        throw new Error('Invalid image preparation configuration');
    const side = options.maximumSide;
    // Generated JPEG headers are small. Never buffer the encoded image to find its dimensions.
    const prefix = Buffer.alloc(outputMimeType === 'image/png' ? 24 : 65536);
    let length = 0;
    const inspect = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            const copied = Math.min(prefix.length - length, chunk.length);
            chunk.copy(prefix, length, 0, copied);
            length += copied;
            callback(null, chunk);
        },
    });
    const pixels =
        outputMimeType === 'image/jpeg' ? new PassThrough({highWaterMark: 65536}) : undefined;
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const fail = (error: unknown): never => {
        abort.abort();
        pixels?.destroy();
        inspect.destroy();
        throw error;
    };
    const transfer = pipeline(inspect, output).catch(fail);
    const encoded = pixels
        ? runCodecProcess(pixels, inspect, {
              ...options,
              signal,
              executable: options.jpegExecutable ?? '/usr/local/bin/jpeg-encode',
              args: [String(quality), String(options.maximumPixels)],
              maximumInputBytes: options.maximumPixels * 4 + 256,
              allowEarlyInputClose: false,
          }).catch(fail)
        : undefined;
    const codec = runCodecProcess(input, pixels ?? inspect, {
        ...options,
        signal,
        maximumOutputBytes: pixels ? options.maximumPixels * 4 + 256 : options.maximumOutputBytes,
        allowEarlyInputClose: options.mimeType === 'image/gif',
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
            '-max_pixels',
            String(options.maximumPixels),
            '-err_detect',
            'explode',
            '-f',
            options.mimeType === 'image/png'
                ? 'png_pipe'
                : options.mimeType === 'image/jpeg'
                  ? 'jpeg_pipe'
                  : options.mimeType === 'image/gif'
                    ? 'gif'
                    : options.mimeType === 'image/webp'
                      ? 'webp_pipe'
                      : 'pam_pipe',
            '-i',
            'pipe:0',
            '-map',
            '0:v:0',
            '-an',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-frames:v',
            '1',
            '-vf',
            // Auto-orientation runs before this filter. Drop frame side data as well as
            // container metadata: newer FFmpeg versions otherwise retain EXIF in PNG output.
            // Flatten before scaling so hidden colors cannot bleed across alpha edges.
            // Explicit integer rounding matches canvas; premultiply's 8-bit path loses
            // RGB precision, even for opaque samples, and its float path rounds differently.
            // PNG scales premultiplied 16-bit color and alpha together, then
            // restores straight alpha, preventing hidden colors from bleeding at edges.
            // Quantize alpha explicitly before swscale's 16-to-8 conversion: otherwise
            // the replicated 16-bit value for alpha 128 becomes 129 on output.
            `${outputMimeType === 'image/jpeg' ? "format=gbrap,geq=r='floor(r(X,Y)*alpha(X,Y)/255+0.5)':g='floor(g(X,Y)*alpha(X,Y)/255+0.5)':b='floor(b(X,Y)*alpha(X,Y)/255+0.5)':a=255,format=rgb24," : 'format=gbrap16le,premultiply=inplace=1:planes=7,'}scale=w=max(1\\,round(iw*min(1\\,${side}/max(iw\\,ih)))):h=max(1\\,round(ih*min(1\\,${side}/max(iw\\,ih)))),${outputMimeType === 'image/png' ? "unpremultiply=inplace=1:planes=7,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='floor(alpha(X,Y)/257+0.5)*256',format=rgba," : ''}setsar=1,sidedata=mode=delete`,
            '-c:v',
            ...(outputMimeType === 'image/png' ? ['png'] : ['pam', '-pix_fmt', 'rgb24']),
            '-threads',
            '1',
            '-f',
            'image2pipe',
            'pipe:1',
        ],
    }).catch(fail);
    const results = await Promise.allSettled([codec, transfer, encoded]);
    if (
        results[0].status !== 'fulfilled' ||
        results[1].status !== 'fulfilled' ||
        results[2].status !== 'fulfilled'
    )
        throw new Error('Image preparation failed');
    let width: number, height: number;
    if (outputMimeType === 'image/png') {
        if (
            length !== 24 ||
            !prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            prefix.readUInt32BE(8) !== 13 ||
            prefix.toString('ascii', 12, 16) !== 'IHDR'
        )
            throw new Error('Invalid prepared image');
        width = prefix.readUInt32BE(16);
        height = prefix.readUInt32BE(20);
    } else {
        ({width, height} = jpegDimensions(prefix.subarray(0, length)));
    }
    if (
        !width ||
        !height ||
        width > side ||
        height > side ||
        width * height > options.maximumPixels
    )
        throw new Error('Prepared image dimensions exceed limits');
    return {
        mimeType: outputMimeType,
        width,
        height,
        bytes: results[2].value?.outputBytes ?? results[0].value.outputBytes,
    };
}

/** Accept only the baseline SOF emitted by our JPEG encoder, before scan data. */
function jpegDimensions(header: Buffer): {width: number; height: number} {
    if (header.length < 4 || header.readUInt16BE(0) !== 0xffd8)
        throw new Error('Invalid prepared JPEG');
    let offset = 2;
    while (offset + 4 <= header.length) {
        if (header[offset++] !== 0xff) break;
        while (header[offset] === 0xff) offset++;
        const marker = header[offset++];
        if (
            marker === undefined ||
            marker === 0xda ||
            marker === 0xd9 ||
            offset + 2 > header.length
        )
            break;
        const length = header.readUInt16BE(offset);
        if (length < 2 || offset + length > header.length) break;
        if (marker === 0xc0) {
            if (length !== 17 || header[offset + 2] !== 8 || header[offset + 7] !== 3) break;
            return {
                height: header.readUInt16BE(offset + 3),
                width: header.readUInt16BE(offset + 5),
            };
        }
        offset += length;
    }
    throw new Error('Invalid prepared JPEG dimensions');
}
