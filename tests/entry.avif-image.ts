import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable, Writable} from 'node:stream';
import {prepareAvifBundle} from '../src/media/avif-bundle.ts';
import {prepareAvifImage} from '../src/media/avif-image.ts';
import {prepareGeneratedAttachment} from '../src/media/generated-attachment.ts';
import {avifGrid} from './fixtures/avif-grid.ts';

await test('AVIF process pipeline encrypts canonical output and rejects late input failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avif-image-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const options = {
        limiter,
        jpegExecutable:
            process.env.JPEG_ENCODER_TEST_EXECUTABLE ??
            fileURLToPath(new URL('../.local/jpeg-encode', import.meta.url)),
        executable:
            process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
        avifExecutable:
            process.env.AVIF_FIRST_FRAME_TEST_EXECUTABLE ??
            fileURLToPath(new URL('../.local/avif-first-frame', import.meta.url)),
        inputBytes: avifGrid.length,
        maximumInputBytes: 4 * 1024 * 1024,
        maximumOutputBytes: 4096,
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        timeoutMs: 3000,
        maximumPixels: 1000,
        maximumSide: 16,
    };
    const capture = (
        input: Readable,
        changes: Partial<typeof options> & {signal?: AbortSignal} = {},
    ) =>
        prepareGeneratedAttachment(
            (output) => prepareAvifImage(input, output, {...options, ...changes}),
            directory,
            {
                maximumBytes: 4096,
                mimeType: 'image/png',
                verifyMime: async (header) => {
                    assert.equal(header.subarray(1, 4).toString(), 'PNG');
                },
            },
        );
    const spools = async () =>
        (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'));
    try {
        const prepared = await capture(Readable.from([avifGrid]));
        assert.equal(prepared.metadata.width, 4);
        assert.equal(prepared.metadata.height, 8);
        const chunks: Buffer[] = [];
        for await (const chunk of prepared.attachment.stream()) chunks.push(Buffer.from(chunk));
        const png = Buffer.concat(chunks);
        assert.equal(png.length, prepared.metadata.bytes);
        const names = await spools();
        assert.equal(names.length, 1);
        for (const name of await readdir(join(directory, names[0]!))) {
            const bytes = await readFile(join(directory, names[0]!, name));
            assert(!bytes.equals(png), 'Only ciphertext may persist');
            assert(!bytes.includes(avifGrid));
        }
        await prepared.attachment.dispose();
        assert.deepEqual(await spools(), []);

        // The native decoder can finish after its frame; the adapter must still consume the tail.
        let drained = 0;
        const tailBytes = 2 * 1024 * 1024;
        const tail = Readable.from(
            (async function* () {
                yield avifGrid;
                for (let offset = 0; offset < tailBytes; offset += 65536) {
                    drained += 65536;
                    yield Buffer.alloc(65536);
                }
            })(),
        );
        const extended = await capture(tail, {inputBytes: avifGrid.length + tailBytes});
        assert.equal(drained, tailBytes);
        await extended.attachment.dispose();
        await assert.rejects(
            capture(
                Readable.from(
                    (async function* () {
                        yield avifGrid;
                        throw new Error('synthetic late authentication failure');
                    })(),
                ),
            ),
        );
        await assert.rejects(capture(Readable.from([avifGrid]), {inputBytes: avifGrid.length + 1}));
        await assert.rejects(capture(Readable.from([avifGrid]), {maximumOutputBytes: 1}));
        await assert.rejects(
            capture(Readable.from([avifGrid]), {avifExecutable: '/missing/decoder'}),
        );
        const abort = new AbortController();
        const stalled = new Readable({read() {}});
        const pending = capture(stalled, {signal: abort.signal});
        const timer = setTimeout(() => abort.abort(), 40);
        try {
            await assert.rejects(pending);
        } finally {
            clearTimeout(timer);
        }
        assert(stalled.destroyed);
        assert.deepEqual(await spools(), []);

        const original = async () =>
            (
                await prepareGeneratedAttachment(
                    async (output) => {
                        output.end(avifGrid);
                        return {};
                    },
                    directory,
                    {
                        maximumBytes: avifGrid.length,
                        mimeType: 'image/avif',
                        verifyMime: async (header) => {
                            assert.equal(header.toString('ascii', 4, 8), 'ftyp');
                        },
                    },
                )
            ).attachment;
        const bundleOptions = {
            ...options,
            maximumSide: 1,
            thumbnailSide: 4,
            maximumThumbnailBytes: 4096,
        };
        const source = await original();
        let reads = 0;
        const bundle = await prepareAvifBundle(
            {
                ...source,
                stream() {
                    reads++;
                    return source.stream();
                },
            },
            directory,
            bundleOptions,
        );
        assert.equal(reads, 2, 'Both encodings must read the original verified source');
        assert.equal(bundle.image.metadata.mimeType, 'image/png');
        assert.equal(bundle.thumbnail.metadata.mimeType, 'image/jpeg');
        assert.deepEqual([bundle.image.metadata.width, bundle.image.metadata.height], [1, 1]);
        assert.deepEqual(
            [bundle.thumbnail.metadata.width, bundle.thumbnail.metadata.height],
            [2, 4],
        );
        assert.equal((await spools()).length, 2, 'Original spool is removed before handoff');
        await bundle.dispose();
        assert.deepEqual(await spools(), []);
        await assert.rejects(
            prepareAvifBundle(await original(), directory, {
                ...bundleOptions,
                maximumThumbnailBytes: 1,
            }),
        );
        assert.deepEqual(await spools(), [], 'Thumbnail failure also removes main and source');
        const failingSource = await original();
        let cleanups = 0;
        await assert.rejects(
            prepareAvifBundle(
                {
                    ...failingSource,
                    async dispose() {
                        if (++cleanups === 1) throw new Error('synthetic source cleanup failure');
                        await failingSource.dispose();
                    },
                },
                directory,
                bundleOptions,
            ),
        );
        assert.equal(cleanups, 2);
        assert.deepEqual(await spools(), [], 'Source cleanup failure must prevent bundle handoff');

        const output = new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            },
        });
        await assert.rejects(
            prepareAvifImage(Readable.from([avifGrid]), output, {...options, inputBytes: NaN}),
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
