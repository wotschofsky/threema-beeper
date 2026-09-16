import type {Readable, Writable} from 'node:stream';
import {prepareDecodedImage} from './decoded-image.ts';
import type {prepareStaticImage} from './image-codec.ts';

/** Provisional AVIF adapter: color-management parity must precede production admission. */
export async function prepareAvifImage(
    input: Readable,
    output: Writable,
    options: Omit<Parameters<typeof prepareStaticImage>[2], 'mimeType' | 'outputMimeType'> & {
        avifExecutable: string;
        inputBytes: number;
    },
) {
    return prepareDecodedImage(input, output, {
        ...options,
        outputMimeType: 'image/png',
        decoderExecutable: options.avifExecutable,
        decoderArgs: ['33554432', String(options.maximumPixels), String(options.inputBytes)],
        expectedInputBytes: options.inputBytes,
    });
}
