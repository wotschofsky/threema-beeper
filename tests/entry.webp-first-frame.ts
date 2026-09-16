import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable, Writable} from 'node:stream';
import {runCodecProcess} from '../src/media/codec-process.ts';

// Two lossless 4x4 frames at offsets (4,2) and (8,4), on a transparent 12x8 canvas.
const animation = Buffer.from(
    'UklGRoQAAABXRUJQVlA4WAoAAAASAAAACwAABwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAIAAAEAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAQBxD9j/4EIqL/AQBBTk1GKAAAAAQAAAIAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAAB1DAiP4HIqL/AQA=',
    'base64',
);
await test('native WebP decoder composites only the first frame and bounds prefix/canvas work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webp-first-frame-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const decode = async (bytes: Buffer, args = ['1048576', '1000']) => {
        const chunks: Buffer[] = [];
        const result = await runCodecProcess(
            Readable.from([bytes]),
            new Writable({
                write(chunk: Buffer, _encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
            }),
            {
                limiter,
                executable:
                    process.env.WEBP_FIRST_FRAME_TEST_EXECUTABLE ??
                    fileURLToPath(new URL('../.local/webp-first-frame', import.meta.url)),
                args,
                cpuSeconds: 2,
                memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                maximumInputBytes: 4 * 1024 * 1024,
                maximumOutputBytes: 1024,
                timeoutMs: 3000,
                allowEarlyInputClose: true,
            },
        );
        assert.equal(result.inputBytes, bytes.length);
        return Buffer.concat(chunks);
    };
    try {
        const output = await decode(animation);
        const header = 'P7\nWIDTH 12\nHEIGHT 8\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n';
        assert.equal(output.subarray(0, header.length).toString(), header);
        const pixels = output.subarray(header.length);
        assert.equal(pixels.length, 12 * 8 * 4);
        for (let y = 0; y < 8; y++)
            for (let x = 0; x < 12; x++) {
                const expected =
                    x >= 4 && x < 8 && y >= 2 && y < 6 ? [255, 0, 0, 63] : [0, 0, 0, 0];
                assert.deepEqual(
                    [...pixels.subarray((y * 12 + x) * 4, (y * 12 + x + 1) * 4)],
                    expected,
                );
            }
        const tail = Buffer.alloc(2 * 1024 * 1024);
        const chunk = Buffer.alloc(8);
        chunk.write('JUNK');
        chunk.writeUInt32LE(tail.length, 4);
        const extended = Buffer.concat([animation, chunk, tail]);
        extended.writeUInt32LE(extended.length - 8, 4);
        assert.deepEqual(
            await decode(extended),
            output,
            'Later chunks need not be buffered by the decoder',
        );
        const metadata = Buffer.from('private metadata');
        const exif = Buffer.alloc(8);
        exif.write('EXIF');
        exif.writeUInt32LE(metadata.length, 4);
        const withMetadata = Buffer.concat([animation, exif, metadata]);
        withMetadata[20] = withMetadata[20]! | 8;
        withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
        assert.deepEqual(await decode(withMetadata), output, 'Source metadata is absent from pixels');
        await assert.rejects(decode(animation, ['32', '1000']));
        await assert.rejects(decode(animation, ['1048576', '95']));
        await assert.rejects(decode(animation.subarray(0, 10)));
        await assert.rejects(decode(animation.subarray(0, 75)));
        const oversizedChunk = Buffer.from(animation);
        oversizedChunk.writeUInt32LE(0xffffffff, 16);
        await assert.rejects(decode(oversizedChunk));
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
