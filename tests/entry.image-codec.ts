import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, rm, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {Readable, Writable} from 'node:stream';
import {prepareStaticImage} from '../src/media/image-codec.ts';
import {prepareGeneratedAttachment} from '../src/media/generated-attachment.ts';
import {prepareImageBundle} from '../src/media/image-bundle.ts';
import {prepareRetainedImageBundle} from '../src/media/retained-image-bundle.ts';

function pngChunkTypes(bytes: Buffer): string[] {
    const types: string[] = [];
    let offset = 8;
    while (offset < bytes.length) {
        assert(offset + 12 <= bytes.length);
        const length = bytes.readUInt32BE(offset);
        assert(offset + 12 + length <= bytes.length);
        types.push(bytes.toString('ascii', offset + 4, offset + 8));
        offset += length + 12;
    }
    assert.equal(types.at(-1), 'IEND');
    return types;
}
await test('real image codec derives resized dimensions and rejects corrupt, mismatched and oversized images', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'image-codec-'));
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const limiter =
        process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'synthetic-launcher');
    // The macOS codec test isolates adapter behavior; Linux hard limits are tested separately.
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const fixtureFor = (codec = 'png', size = '40x20') =>
        execFileSync(executable, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            `testsrc=size=${size}`,
            '-frames:v',
            '1',
            '-c:v',
            codec,
            '-f',
            'image2pipe',
            'pipe:1',
        ]);
    const fixture = fixtureFor();
    const originalSource = (bytes: Buffer) => ({
        bytes: bytes.length,
        stream: () => Readable.from([bytes]),
        dispose: async () => {},
    });
    const options = {
        limiter,
        jpegExecutable:
            process.env.JPEG_ENCODER_TEST_EXECUTABLE ??
            fileURLToPath(new URL('../.local/jpeg-encode', import.meta.url)),
        executable,
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        maximumInputBytes: 1024 * 1024,
        maximumOutputBytes: 1024 * 1024,
        timeoutMs: 3000,
        mimeType: 'image/png' as const,
        maximumSide: 16,
        maximumPixels: 4096,
    };
    async function prepare(
        bytes: Buffer,
        changes: Partial<Parameters<typeof prepareStaticImage>[2]> = {},
    ) {
        const chunks: Buffer[] = [];
        const metadata = await prepareStaticImage(
            Readable.from([bytes]),
            new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
            }),
            {...options, ...changes},
        );
        return {metadata, bytes: Buffer.concat(chunks)};
    }
    try {
        const reference = JSON.parse(
            await readFile(new URL('./fixtures/renderer-jpeg.json', import.meta.url), 'utf8'),
        ) as {
            fixtures: {name: string; width: number; height: number; rgba: string}[];
            results: {name: string; quality: number; jpeg: string}[];
        };
        for (const expected of reference.results) {
            const source = reference.fixtures.find((item) => item.name === expected.name)!;
            const pam = Buffer.concat([
                Buffer.from(
                    `P7\nWIDTH ${source.width}\nHEIGHT ${source.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
                ),
                Buffer.from(source.rgba, 'base64'),
            ]);
            const prepared = await prepare(pam, {
                mimeType: 'image/x-portable-arbitrarymap',
                outputMimeType: 'image/jpeg',
                maximumSide: 32,
                jpegQuality: expected.quality,
            });
            assert.deepEqual(
                prepared.bytes,
                Buffer.from(expected.jpeg, 'base64'),
                `${expected.name} pipeline quality ${expected.quality}`,
            );
        }
        await assert.rejects(
            prepare(fixture, {
                outputMimeType: 'image/jpeg',
                jpegExecutable: '/missing/jpeg-encode',
            }),
        );
        await assert.rejects(
            prepare(fixture, {outputMimeType: 'image/jpeg', maximumOutputBytes: 1}),
        );
        await assert.rejects(prepare(fixture, {outputMimeType: 'image/jpeg', jpegQuality: 101}));
        for (const alpha of [0, 63, 128, 255]) {
            const rgba = Buffer.from(Array.from({length: 16}, () => [255, 0, 0, alpha]).flat());
            const pam = Buffer.concat([
                Buffer.from(
                    'P7\nWIDTH 4\nHEIGHT 4\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n',
                ),
                rgba,
            ]);
            const jpeg = await prepare(pam, {
                mimeType: 'image/x-portable-arbitrarymap',
                outputMimeType: 'image/jpeg',
            });
            const decoded = execFileSync(
                executable,
                [
                    '-v',
                    'error',
                    '-f',
                    'jpeg_pipe',
                    '-i',
                    'pipe:0',
                    '-frames:v',
                    '1',
                    '-pix_fmt',
                    'rgb24',
                    '-f',
                    'rawvideo',
                    'pipe:1',
                ],
                {input: jpeg.bytes},
            );
            assert.equal(decoded.length, 48);
            for (let offset = 0; offset < decoded.length; offset += 3) {
                assert(
                    Math.abs(decoded[offset]! - alpha) <= 4,
                    `JPEG must blend alpha ${alpha} on black, got ${decoded[offset]}`,
                );
                assert(decoded[offset + 1]! <= 4 && decoded[offset + 2]! <= 4);
            }
            const png = await prepare(pam, {mimeType: 'image/x-portable-arbitrarymap'});
            const decodedPng = execFileSync(
                executable,
                [
                    '-v',
                    'error',
                    '-f',
                    'png_pipe',
                    '-i',
                    'pipe:0',
                    '-frames:v',
                    '1',
                    '-pix_fmt',
                    'rgba',
                    '-f',
                    'rawvideo',
                    'pipe:1',
                ],
                {input: png.bytes},
            );
            assert.deepEqual(
                decodedPng,
                alpha === 0 ? Buffer.alloc(rgba.length) : rgba,
                'PNG preserves visible color and alpha; transparent pixels become black like canvas',
            );
        }
        const resizeReference = JSON.parse(
            await readFile(new URL('./fixtures/renderer-resize.json', import.meta.url), 'utf8'),
        ) as {
            fixtures: {name: string; width: number; height: number; rgba: string}[];
        };
        const alphaRamp = Buffer.from(
            Array.from({length: 256}, (_, alpha) => [64, 128, 192, alpha]).flat(),
        );
        const rampPng = await prepare(
            Buffer.concat([
                Buffer.from(
                    'P7\nWIDTH 256\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n',
                ),
                alphaRamp,
            ]),
            {mimeType: 'image/x-portable-arbitrarymap', maximumSide: 256},
        );
        const rampPixels = execFileSync(
            executable,
            [
                '-v',
                'error',
                '-f',
                'png_pipe',
                '-i',
                'pipe:0',
                '-frames:v',
                '1',
                '-pix_fmt',
                'rgba',
                '-f',
                'rawvideo',
                'pipe:1',
            ],
            {input: rampPng.bytes},
        );
        for (let alpha = 0; alpha < 256; alpha++) assert.equal(rampPixels[alpha * 4 + 3], alpha);
        const transparentEdge = resizeReference.fixtures.find(
            (item) => item.name === 'alpha-edge-32',
        )!;
        const edgeInput = Buffer.concat([
            Buffer.from(
                'P7\nWIDTH 32\nHEIGHT 32\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n',
            ),
            Buffer.from(transparentEdge.rgba, 'base64'),
        ]);
        for (const maximumSide of [16, 8, 4, 1]) {
            const png = await prepare(edgeInput, {
                mimeType: 'image/x-portable-arbitrarymap',
                maximumSide,
            });
            const rgba = execFileSync(
                executable,
                [
                    '-v',
                    'error',
                    '-f',
                    'png_pipe',
                    '-i',
                    'pipe:0',
                    '-frames:v',
                    '1',
                    '-pix_fmt',
                    'rgba',
                    '-f',
                    'rawvideo',
                    'pipe:1',
                ],
                {input: png.bytes},
            );
            let visible = 0;
            for (let offset = 0; offset < rgba.length; offset += 4) {
                assert.equal(rgba[offset], 0, 'Hidden red must not bleed into a resized PNG');
                if (rgba[offset + 3]! > 0) {
                    visible++;
                    assert(Math.abs(rgba[offset + 1]! - 64) <= 1);
                    assert.equal(rgba[offset + 2], 255);
                }
            }
            assert(visible > 0);
        }
        const edge = Buffer.concat([
            Buffer.from('P7\nWIDTH 4\nHEIGHT 4\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n'),
            Buffer.from(
                Array.from({length: 16}, (_, i) =>
                    i % 4 < 2 ? [255, 0, 0, 0] : [0, 0, 255, 255],
                ).flat(),
            ),
        ]);
        const edgeJpeg = await prepare(edge, {
            mimeType: 'image/x-portable-arbitrarymap',
            outputMimeType: 'image/jpeg',
            maximumSide: 1,
        });
        const edgePixel = execFileSync(
            executable,
            [
                '-v',
                'error',
                '-f',
                'jpeg_pipe',
                '-i',
                'pipe:0',
                '-frames:v',
                '1',
                '-pix_fmt',
                'rgb24',
                '-f',
                'rawvideo',
                'pipe:1',
            ],
            {input: edgeJpeg.bytes},
        );
        assert(edgePixel[0]! <= 4, 'Hidden red must not bleed into the resized JPEG');
        const flattenedEdge = Buffer.from(edge);
        const pixelStart = flattenedEdge.indexOf('ENDHDR\n') + 7;
        for (let i = 0; i < 16; i++)
            if (i % 4 < 2) {
                flattenedEdge[pixelStart + i * 4] = 0;
                flattenedEdge[pixelStart + i * 4 + 3] = 255;
            }
        const opaqueEdgeJpeg = await prepare(flattenedEdge, {
            mimeType: 'image/x-portable-arbitrarymap',
            outputMimeType: 'image/jpeg',
            maximumSide: 1,
        });
        assert.deepEqual(
            edgeJpeg.bytes,
            opaqueEdgeJpeg.bytes,
            'Resizing transparent colors must match resizing their black-composited equivalent',
        );
        const result = await prepare(fixture);
        assert.deepEqual(result.metadata, {
            mimeType: 'image/png',
            width: 16,
            height: 8,
            bytes: result.bytes.length,
        });
        const unchanged = await prepare(fixture, {maximumSide: 1024});
        assert.equal(unchanged.metadata.width, 40);
        assert.equal(unchanged.metadata.height, 20);
        const bundle = await prepareImageBundle(originalSource(fixture), directory, {
            ...options,
            maximumSide: 1,
            thumbnailSide: 8,
            maximumThumbnailBytes: 4096,
        });
        assert.equal(bundle.image.metadata.width, 1);
        assert.equal(bundle.thumbnail.metadata.width, 8);
        assert.equal(bundle.thumbnail.metadata.height, 4);
        const originalThumbnail = await prepare(fixture, {maximumSide: 8});
        const thumbnailChunks: Buffer[] = [];
        for await (const chunk of bundle.thumbnail.attachment.stream()) thumbnailChunks.push(chunk);
        assert.deepEqual(Buffer.concat(thumbnailChunks), originalThumbnail.bytes);
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            2,
        );
        await bundle.dispose();
        await bundle.dispose();
        let sourceCleanupAttempts = 0,
            sourceReads = 0;
        await assert.rejects(
            prepareImageBundle(
                {
                    bytes: fixture.length,
                    stream: () => {
                        sourceReads++;
                        return Readable.from([fixture]);
                    },
                    dispose: async () => {
                        if (++sourceCleanupAttempts === 1)
                            throw new Error('Synthetic cleanup failure');
                    },
                },
                directory,
                {...options, thumbnailSide: 8, maximumThumbnailBytes: 4096},
            ),
        );
        assert.equal(sourceReads, 2);
        assert.equal(sourceCleanupAttempts, 2);
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
        );
        await assert.rejects(
            prepareImageBundle(originalSource(fixture), directory, {
                ...options,
                thumbnailSide: 8,
                maximumThumbnailBytes: 1,
            }),
        );
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
            'Thumbnail failure also removes the completed main image',
        );
        const spooled = await prepareGeneratedAttachment(
            (output) => prepareStaticImage(Readable.from([fixture]), output, options),
            directory,
            {
                maximumBytes: options.maximumOutputBytes,
                mimeType: 'image/png',
                verifyMime: async (header) => {
                    assert.equal(header.toString('ascii', 1, 4), 'PNG');
                },
            },
        );
        assert.equal(spooled.metadata.width, 16);
        assert.equal(spooled.attachment.bytes, spooled.metadata.bytes);
        const spools = (await readdir(directory)).filter((name) =>
            name.startsWith('outbound-attachment-'),
        );
        assert.equal(spools.length, 1);
        const ciphertext = await readFile(join(directory, spools[0]!, 'ciphertext'));
        assert.equal(ciphertext.length, spooled.metadata.bytes);
        assert.notDeepEqual(ciphertext, result.bytes);
        const decrypted: Buffer[] = [];
        for await (const chunk of spooled.attachment.stream()) decrypted.push(chunk);
        assert.deepEqual(Buffer.concat(decrypted), result.bytes);
        await spooled.attachment.dispose();
        await assert.rejects(
            prepareGeneratedAttachment(
                async (output) => {
                    output.write('private failed image');
                    throw new Error('synthetic codec failure');
                },
                directory,
                {maximumBytes: 1024, mimeType: 'image/png', verifyMime: async () => {}},
            ),
        );
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
        );
        const jpeg = await prepare(fixtureFor('mjpeg'), {mimeType: 'image/jpeg'});
        assert.equal(jpeg.metadata.width, 16);
        assert.equal(jpeg.metadata.height, 8);
        const encodedJpeg = await prepare(fixtureFor('mjpeg'), {
            mimeType: 'image/jpeg',
            outputMimeType: 'image/jpeg',
        });
        assert.deepEqual(encodedJpeg.metadata, {
            mimeType: 'image/jpeg',
            width: 16,
            height: 8,
            bytes: encodedJpeg.bytes.length,
        });
        assert.equal(encodedJpeg.bytes.readUInt16BE(0), 0xffd8);
        const decodedJpeg = await prepare(encodedJpeg.bytes, {mimeType: 'image/jpeg'});
        assert.equal(decodedJpeg.metadata.width, 16);
        assert.equal(decodedJpeg.metadata.height, 8);
        const jpegBundle = await prepareImageBundle(
            originalSource(fixtureFor('mjpeg')),
            directory,
            {
                ...options,
                mimeType: 'image/jpeg',
                outputMimeType: 'image/jpeg',
                thumbnailSide: 8,
                maximumThumbnailBytes: 4096,
            },
        );
        try {
            assert.equal(jpegBundle.image.metadata.mimeType, 'image/jpeg');
            assert.equal(jpegBundle.thumbnail.metadata.mimeType, 'image/jpeg');
            assert.equal(jpegBundle.thumbnail.metadata.width, 8);
            assert.equal(jpegBundle.thumbnail.metadata.height, 4);
            const quantization = (bytes: Buffer) => {
                const tables: Buffer[] = [];
                let offset = 2;
                while (offset + 4 <= bytes.length) {
                    const marker = bytes[offset + 1];
                    if (marker === 0xda) break;
                    const length = bytes.readUInt16BE(offset + 2);
                    assert(length >= 2 && offset + 2 + length <= bytes.length);
                    if (marker === 0xdb)
                        tables.push(bytes.subarray(offset + 4, offset + 2 + length));
                    offset += 2 + length;
                }
                assert.equal(tables.length, 2);
                return Buffer.concat(tables);
            };
            for (const [prepared, quality] of [
                [jpegBundle.image, 85],
                [jpegBundle.thumbnail, 80],
            ] as const) {
                const encoded: Buffer[] = [];
                for await (const chunk of prepared.attachment.stream()) encoded.push(chunk);
                const expected = reference.results.find((item) => item.quality === quality)!;
                assert.deepEqual(
                    quantization(Buffer.concat(encoded)),
                    quantization(Buffer.from(expected.jpeg, 'base64')),
                );
            }
            const chunks: Buffer[] = [];
            for await (const chunk of jpegBundle.thumbnail.attachment.stream()) chunks.push(chunk);
            const decoded = await prepare(Buffer.concat(chunks), {mimeType: 'image/jpeg'});
            assert.equal(decoded.metadata.width, 8);
            assert.equal(decoded.metadata.height, 4);
        } finally {
            await jpegBundle.dispose();
        }
        // Minimal little-endian EXIF IFD: Orientation=6 rotates the stored 40x20 pixels.
        const jpegBytes = fixtureFor('mjpeg');
        const exif = Buffer.from(
            '45786966000049492a0008000000010012010300010000000600000000000000',
            'hex',
        );
        const app1 = Buffer.alloc(4);
        app1.writeUInt16BE(0xffe1);
        app1.writeUInt16BE(exif.length + 2, 2);
        const oriented = await prepare(
            Buffer.concat([jpegBytes.subarray(0, 2), app1, exif, jpegBytes.subarray(2)]),
            {mimeType: 'image/jpeg'},
        );
        assert.equal(oriented.metadata.width, 8);
        assert.equal(oriented.metadata.height, 16);
        // Re-decoding the canonical output must not rotate it a second time.
        const orientedAgain = await prepare(oriented.bytes);
        assert.equal(orientedAgain.metadata.width, 8);
        assert.equal(orientedAgain.metadata.height, 16);
        assert(!pngChunkTypes(oriented.bytes).includes('eXIf'), 'EXIF is removed after rotation');
        const animatedPng = execFileSync(executable, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=40x20',
            '-frames:v',
            '2',
            '-c:v',
            'apng',
            '-plays',
            '0',
            '-f',
            'apng',
            'pipe:1',
        ]);
        assert(pngChunkTypes(animatedPng).includes('acTL'), 'Fixture contains animation control');
        const flattened = await prepare(animatedPng);
        assert.equal(flattened.metadata.width, 16);
        assert.equal(flattened.metadata.height, 8);
        assert(!pngChunkTypes(flattened.bytes).includes('acTL'));
        assert.deepEqual(flattened.bytes, result.bytes, 'PNG preparation uses the first bitmap');
        const gif = execFileSync(executable, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=40x20:rate=2',
            '-frames:v',
            '2',
            '-f',
            'gif',
            'pipe:1',
        ]);
        const gifOptions = {
            ...options,
            mimeType: 'image/gif' as const,
            thumbnailSide: 8,
            maximumThumbnailBytes: 4096,
        };
        // Synthetic 40x20 fixtures: extended lossy/alpha, lossless and plain lossy WebP.
        for (const [base64, width, height] of [
            [
                'UklGRnIAAABXRUJQVlA4WAoAAAAQAAAAJwAAEwAAQUxQSAoAAAABB9CfiAhERP8DVlA4IEIAAABQAwCdASooABQAPpFGnkslo6KhpWgAsBIJZwDO3oAAK/fDcAD+7qY//2LOWwLx//7nA/7nA/7nA/jbB+29aoAAAAA=',
                40,
                20,
            ],
            ['UklGRhwAAABXRUJQVlA4TA8AAAAvJ8AEEAcQ/Y/+BCKi/wEA', 40, 20],
            [
                'UklGRk4AAABXRUJQVlA4IEIAAABQAwCdASooABQAPpFGnkslo6KhpWgAsBIJZwDO3oAAK/fDcAD+7tPf/2LOWwLx//7nA/7nA/7nA/jbB+29aoAAAAA=',
                40,
                20,
            ],
            [
                'UklGRoQAAABXRUJQVlA4WAoAAAASAAAACwAABwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAIAAAEAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAQBxD9j/4EIqL/AQBBTk1GKAAAAAQAAAIAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAAB1DAiP4HIqL/AQA=',
                12,
                8,
            ],
        ] as const) {
            const webp = Buffer.from(base64, 'base64');
            const webpOptions = {
                ...gifOptions,
                mimeType: 'image/webp' as const,
                webpExecutable:
                    process.env.WEBP_FIRST_FRAME_TEST_EXECUTABLE ??
                    fileURLToPath(new URL('../.local/webp-first-frame', import.meta.url)),
            };
            const bundle = await prepareRetainedImageBundle(
                Readable.from([webp]),
                directory,
                webpOptions,
            );
            try {
                assert.deepEqual(bundle.image.metadata, {
                    mimeType: 'image/webp',
                    width,
                    height,
                    bytes: webp.length,
                });
                const retained: Buffer[] = [];
                for await (const chunk of bundle.image.attachment.stream()) retained.push(chunk);
                assert.deepEqual(Buffer.concat(retained), webp);
                assert.equal(bundle.thumbnail.metadata.mimeType, 'image/jpeg');
                assert.equal(bundle.thumbnail.metadata.width, 8);
                assert.equal(bundle.thumbnail.metadata.height, Math.round((height * 8) / width));
            } finally {
                await bundle.dispose();
            }
            const wrongSize = Buffer.from(webp);
            wrongSize.writeUInt32LE(webp.length, 4);
            await assert.rejects(
                prepareRetainedImageBundle(Readable.from([wrongSize]), directory, webpOptions),
            );
            await assert.rejects(
                prepareRetainedImageBundle(
                    Readable.from([webp.subarray(0, 20)]),
                    directory,
                    webpOptions,
                ),
            );
            await assert.rejects(
                prepareRetainedImageBundle(Readable.from([webp]), directory, {
                    ...webpOptions,
                    maximumThumbnailBytes: 1,
                }),
            );
            assert.equal(
                (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                    .length,
                0,
            );
        }
        const largeGif = execFileSync(
            executable,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc2=size=320x180:rate=30',
                '-frames:v',
                '90',
                '-f',
                'gif',
                'pipe:1',
            ],
            {maxBuffer: 16 * 1024 * 1024},
        );
        assert(largeGif.length > 256 * 1024, 'Fixture exceeds pipe buffering');
        const largeBundle = await prepareRetainedImageBundle(Readable.from([largeGif]), directory, {
            ...gifOptions,
            maximumPixels: 1000000,
            maximumInputBytes: 16 * 1024 * 1024,
            maximumOutputBytes: 16 * 1024 * 1024,
        });
        await largeBundle.dispose();
        const gifBundle = await prepareRetainedImageBundle(
            Readable.from([gif]),
            directory,
            gifOptions,
        );
        try {
            assert.deepEqual(gifBundle.image.metadata, {
                mimeType: 'image/gif',
                width: 40,
                height: 20,
                bytes: gif.length,
            });
            const retained: Buffer[] = [];
            for await (const chunk of gifBundle.image.attachment.stream()) retained.push(chunk);
            assert.deepEqual(Buffer.concat(retained), gif, 'Animation bytes remain unchanged');
            assert.equal(gifBundle.thumbnail.metadata.mimeType, 'image/jpeg');
            assert.equal(gifBundle.thumbnail.metadata.width, 8);
            assert.equal(gifBundle.thumbnail.metadata.height, 4);
        } finally {
            await gifBundle.dispose();
        }
        for (const [bytes, changes] of [
            [gif, {maximumThumbnailBytes: 1}],
            [gif, {maximumPixels: 100}],
            [gif.subarray(0, 10), {}],
            [gif, {signal: AbortSignal.abort()}],
        ] as const) {
            await assert.rejects(
                prepareRetainedImageBundle(Readable.from([bytes]), directory, {
                    ...gifOptions,
                    ...changes,
                }),
            );
            assert.equal(
                (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                    .length,
                0,
            );
        }
        for (const size of ['40x1', '1x40']) {
            const narrow = await prepare(fixtureFor('png', size));
            assert.equal(Math.max(narrow.metadata.width, narrow.metadata.height), 16);
            assert.equal(Math.min(narrow.metadata.width, narrow.metadata.height), 1);
        }
        const transparent = execFileSync(executable, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=red@0.25:s=40x20,format=rgba',
            '-frames:v',
            '1',
            '-c:v',
            'png',
            '-f',
            'image2pipe',
            'pipe:1',
        ]);
        const alphaImage = await prepare(transparent);
        const pixels = execFileSync(
            executable,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'png_pipe',
                '-i',
                'pipe:0',
                '-frames:v',
                '1',
                '-pix_fmt',
                'rgba',
                '-f',
                'rawvideo',
                'pipe:1',
            ],
            {input: alphaImage.bytes},
        );
        assert.equal(pixels.length, 16 * 8 * 4);
        for (let index = 3; index < pixels.length; index += 4)
            assert(pixels[index]! >= 63 && pixels[index]! <= 64, 'Resizing preserves transparency');
        await assert.rejects(prepare(Buffer.from('private corrupt image')));
        await assert.rejects(prepare(fixture, {mimeType: 'image/jpeg'}));
        await assert.rejects(prepare(fixture, {maximumPixels: 100}));
        await assert.rejects(prepare(fixture, {maximumOutputBytes: 1}));
        await assert.rejects(prepare(fixture, {signal: AbortSignal.abort()}));
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
