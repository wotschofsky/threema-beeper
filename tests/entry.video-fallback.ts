import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {prepareVideoWithFallback} from '../src/media/video-fallback.ts';
import {VideoPreparationCleanupError} from '../src/media/video-preparation.ts';

await test('video fallback preserves original ownership through failed conversion and enforces terminal failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-fallback-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    const fixture = JSON.parse(
        await readFile(new URL('./fixtures/video-timelines.json', import.meta.url), 'utf8'),
    ).files[0];
    const bytes = Buffer.from(fixture.bytes, 'base64');
    const options = {
        codec: {
            limiter,
            executable:
                process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
            cpuSeconds: 10,
            memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
            maximumInputBytes: 1048576,
            maximumOutputBytes: 1048576,
            timeoutMs: 15000,
        },
        inspection: {
            limiter,
            executable: process.execPath,
            cpuSeconds: 5,
            memoryBytes: Number(process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368),
            timeoutMs: 10000,
            maximumDurationSeconds: 3,
            maximumReadBytes: 1048576,
        },
    };
    const source = () => {
        let disposed = false,
            disposals = 0;
        return {
            bytes: bytes.length,
            read: async (start: number, end: number) => {
                assert(!disposed);
                return Buffer.from(bytes.subarray(start, end));
            },
            stream: () => {
                assert(!disposed);
                return Readable.from([bytes]);
            },
            dispose: async () => {
                disposed = true;
                disposals++;
            },
            get disposals() {
                return disposals;
            },
        };
    };
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const original = source();
        const unavailable = {
            ...options,
            codec: {...options.codec, executable: join(directory, 'missing-encoder')},
        };
        const fallback = await prepareVideoWithFallback(
            original,
            directory,
            unavailable,
            'video/quicktime',
        );
        assert.equal(fallback.encoding, 'original');
        assert.equal(fallback.prepared.attachment, original);
        assert.deepEqual(fallback.prepared.metadata, {
            mimeType: 'video/quicktime',
            bytes: bytes.length,
        });
        assert.equal(original.disposals, 0);
        assert.deepEqual(await fallback.prepared.attachment.read(0, bytes.length), bytes);
        await fallback.prepared.attachment.dispose();
        assert.equal(original.disposals, 1);
        const convertible = source();
        const converted = await prepareVideoWithFallback(
            convertible,
            directory,
            options,
            'video/mp4',
        );
        assert.equal(converted.encoding, 'avc');
        assert.equal(convertible.disposals, 1);
        assert.equal(converted.prepared.metadata.mimeType, 'video/mp4');
        assert('durationSeconds' in converted.prepared.metadata);
        assert.equal(converted.prepared.metadata.durationSeconds, fixture.durationSeconds);
        await converted.prepared.attachment.dispose();
        const thumbnailOptions = {
            ...options,
            thumbnail: {
                jpegExecutable: process.env.JPEG_TEST_EXECUTABLE ?? resolve('.local/jpeg-encode'),
                maximumThumbnailBytes: 1048576,
            },
        };
        const withThumbnailSource = source();
        const withThumbnail = await prepareVideoWithFallback(
            withThumbnailSource,
            directory,
            thumbnailOptions,
            'video/mp4',
        );
        assert(withThumbnail.encoding === 'avc' && withThumbnail.thumbnail);
        assert.equal(withThumbnailSource.disposals, 1);
        assert.equal(withThumbnail.thumbnail.metadata.mimeType, 'image/jpeg');
        assert.equal(withThumbnail.thumbnail.metadata.width, 64);
        await Promise.all([
            withThumbnail.prepared.attachment.dispose(),
            withThumbnail.thumbnail.attachment.dispose(),
        ]);
        const optionalFailure = await prepareVideoWithFallback(
            source(),
            directory,
            {
                ...thumbnailOptions,
                thumbnail: {
                    ...thumbnailOptions.thumbnail,
                    jpegExecutable: join(directory, 'missing-jpeg'),
                },
            },
            'video/mp4',
        );
        assert.equal(optionalFailure.encoding, 'avc');
        assert(!('thumbnail' in optionalFailure));
        await optionalFailure.prepared.attachment.dispose();
        const rejectConversion = join(directory, 'reject-mp4');
        const quotedExecutable = "'" + options.codec.executable.replaceAll("'", "'\\''") + "'";
        await writeFile(
            rejectConversion,
            '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = mp4 ]; then exit 1; fi; done\nexec ' +
                quotedExecutable +
                ' "$@"\n',
            {mode: 0o700},
        );
        const originalAfterThumbnail = source();
        const smaller = await prepareVideoWithFallback(
            originalAfterThumbnail,
            directory,
            {...thumbnailOptions, codec: {...options.codec, executable: rejectConversion}},
            'video/mp4',
        );
        assert.equal(smaller.encoding, 'original');
        assert(!('thumbnail' in smaller));
        assert.equal(originalAfterThumbnail.disposals, 0);
        assert.deepEqual(await smaller.prepared.attachment.read(0, bytes.length), bytes);
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
            'A generated thumbnail cannot survive original-file fallback',
        );
        await smaller.prepared.attachment.dispose();
        const oversized = source();
        await assert.rejects(
            prepareVideoWithFallback(
                oversized,
                directory,
                {...unavailable, codec: {...unavailable.codec, maximumOutputBytes: 1}},
                'video/mp4',
            ),
        );
        assert.equal(oversized.disposals, 1);
        for (const stage of ['codec', 'inspection'] as const) {
            const abort = new AbortController();
            const interrupted = source();
            const read = interrupted.read;
            interrupted.read = async (start, end) => {
                abort.abort();
                return read(start, end);
            };
            await assert.rejects(
                prepareVideoWithFallback(
                    interrupted,
                    directory,
                    {...options, [stage]: {...options[stage], signal: abort.signal}},
                    'video/mp4',
                ),
            );
            assert.equal(interrupted.disposals, 1);
        }
        let failedDisposals = 0;
        await assert.rejects(
            prepareVideoWithFallback(
                {
                    ...source(),
                    dispose: async () => {
                        failedDisposals++;
                        throw new Error('Cleanup unavailable');
                    },
                },
                directory,
                options,
                'video/mp4',
            ),
            VideoPreparationCleanupError,
        );
        assert.equal(
            failedDisposals,
            2,
            'Successful conversion cannot hand off output while source cleanup fails',
        );
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
