import type {Readable, Writable} from 'node:stream';
import {prepareDecodedImage} from './decoded-image.ts';
import type {prepareStaticImage} from './image-codec.ts';

export async function prepareWebpThumbnail(
    input: Readable,
    output: Writable,
    options: Omit<Parameters<typeof prepareStaticImage>[2], 'mimeType' | 'outputMimeType'> & {
        webpExecutable: string;
    },
) {
    return prepareDecodedImage(input, output, {
        ...options,
        decoderExecutable: options.webpExecutable,
        decoderArgs: ['33554432', String(options.maximumPixels)],
        outputMimeType: 'image/jpeg',
        jpegQuality: 80,
    });
}
