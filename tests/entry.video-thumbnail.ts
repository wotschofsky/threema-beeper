import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {inspectVideoSource} from '../src/media/video-inspector.ts';
import {prepareVideoThumbnail} from '../src/media/video-thumbnail.ts';

const reference = JSON.parse(
    await readFile(new URL('./fixtures/video-thumbnails.json', import.meta.url), 'utf8'),
);
for (const fixture of reference.files)
    await test(`video thumbnail samples the Desktop frame and bounds output: ${fixture.name}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'video-thumbnail-'));
        const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
        const bytes = Buffer.from(fixture.bytes, 'base64');
        let disposed = 0;
        try {
            assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
            if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
                await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
            const source = {
                bytes: bytes.length,
                read: async (start: number, end: number) => Buffer.from(bytes.subarray(start, end)),
                stream: () => Readable.from([bytes]),
                dispose: async () => {
                    disposed++;
                },
            };
            const inspection = {
                limiter,
                executable: process.execPath,
                cpuSeconds: 5,
                memoryBytes: Number(
                    process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368,
                ),
                timeoutMs: 10000,
                maximumDurationSeconds: 10,
                maximumReadBytes: 4 * 1024 * 1024,
            };
            const inspected = await inspectVideoSource(source, {...inspection, thumbnail: true});
            assert.equal(inspected.thumbnail?.timestamp, fixture.sampleTimestamp);
            const prepared = await prepareVideoThumbnail(source, directory, {
                inspection,
                codec: {
                    limiter,
                    executable:
                        process.env.FFMPEG_TEST_EXECUTABLE ??
                        '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
                    cpuSeconds: 10,
                    memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                    maximumInputBytes: 1048576,
                    maximumOutputBytes: 4 * 1024 * 1024,
                    timeoutMs: 15000,
                },
                jpegExecutable: process.env.JPEG_TEST_EXECUTABLE ?? resolve('.local/jpeg-encode'),
                maximumThumbnailBytes: 1048576,
            });
            try {
                assert.equal(prepared.metadata.width, fixture.width);
                assert.equal(prepared.metadata.height, fixture.height);
                assert.equal(prepared.metadata.mimeType, 'image/jpeg');
                assert.equal(prepared.metadata.bytes, prepared.attachment.bytes);
                assert.equal(disposed, 0, 'Thumbnail preparation borrows the source');
                const output = await prepared.attachment.read(0, prepared.attachment.bytes);
                assert.equal(output[0], 255);
                assert.equal(output[1], 216);
                const spools = (await readdir(directory)).filter((name) =>
                    name.startsWith('outbound-attachment-'),
                );
                assert.equal(spools.length, 1);
                assert.notDeepEqual(
                    await readFile(join(directory, spools[0]!, 'ciphertext')),
                    output,
                );
                if (process.env.VIDEO_THUMBNAIL_REPORT_DIRECTORY) {
                    await writeFile(
                        join(process.env.VIDEO_THUMBNAIL_REPORT_DIRECTORY, fixture.name + '.jpg'),
                        output,
                    );
                }
            } finally {
                await prepared.attachment.dispose();
            }
            assert.deepEqual(
                (await readdir(directory)).filter((name) =>
                    name.startsWith('outbound-attachment-'),
                ),
                [],
            );
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    });
