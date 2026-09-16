import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {inspectVideoSource} from '../src/media/video-inspector.ts';
import {prepareVideoAttachment} from '../src/media/video-preparation.ts';

const references = JSON.parse(
    await readFile(new URL('./fixtures/video-timelines.json', import.meta.url), 'utf8'),
);
const cases = [
    {name: 'rotation-90', source: 'avc-no-bframes', rotation: 90, videos: 1, audios: 0},
    {name: 'rotation-180', source: 'avc-no-bframes', rotation: 180, videos: 1, audios: 0},
    {name: 'rotation-270', source: 'avc-no-bframes', rotation: 270, videos: 1, audios: 0},
    {name: 'two-video-tracks', source: 'avc-no-bframes', rotation: 0, videos: 2, audios: 0},
    {name: 'two-audio-tracks', source: 'avc-aac', rotation: 0, videos: 1, audios: 2},
    {name: 'rotated-vp9', source: 'vp9', rotation: 90, videos: 1, audios: 0},
];
for (const scenario of cases)
    await test(`video geometry and all tracks survive conversion: ${scenario.name}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'video-geometry-'));
        const executable =
            process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
        const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
        try {
            if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
                await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
            const fixture = references.files.find(
                (item: {name: string}) => item.name === scenario.source,
            );
            const original = Buffer.from(fixture.bytes, 'base64');
            assert.equal(createHash('sha256').update(original).digest('hex'), fixture.sha256);
            const inputPath = join(directory, 'input'),
                remuxedPath = join(directory, 'remuxed.mp4');
            await writeFile(inputPath, original);
            execFileSync(
                executable,
                [
                    '-v',
                    'error',
                    '-display_rotation:v:0',
                    String(scenario.rotation),
                    '-i',
                    inputPath,
                    '-map',
                    '0:v:0',
                    ...(scenario.videos === 2 ? ['-map', '0:v:0'] : []),
                    ...(scenario.audios === 2 ? ['-map', '0:a:0', '-map', '0:a:0'] : []),
                    '-c',
                    'copy',
                    '-metadata:s:v:0',
                    `rotate=${scenario.rotation}`,
                    '-movflags',
                    '+faststart',
                    remuxedPath,
                ],
                {timeout: 10000, maxBuffer: 65536},
            );
            const bytes = await readFile(remuxedPath);
            let disposed = false;
            const source = {
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
                maximumDurationSeconds: 3,
                maximumReadBytes: 1048576,
            };
            const input = await inspectVideoSource(source, inspection);
            assert.equal(
                input.tracks.filter((track) => track.type === 'video').length,
                scenario.videos,
            );
            assert.equal(
                input.tracks.filter((track) => track.type === 'audio').length,
                scenario.audios,
            );
            const primary = input.tracks[0]!;
            assert(primary.type === 'video');
            assert.equal(primary.rotation, (360 - scenario.rotation) % 360);
            assert.deepEqual(
                [primary.width, primary.height],
                scenario.rotation % 180 === 0 ? [64, 48] : [48, 64],
            );
            const output = await prepareVideoAttachment(source, directory, {
                inspection,
                codec: {
                    limiter,
                    executable,
                    cpuSeconds: 10,
                    memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                    maximumInputBytes: 1048576,
                    maximumOutputBytes: 1048576,
                    timeoutMs: 15000,
                },
            });
            try {
                assert(disposed);
                assert.deepEqual(
                    [output.metadata.width, output.metadata.height],
                    [primary.width, primary.height],
                );
                assert.equal(output.metadata.durationSeconds, input.durationSeconds);
                const result = await inspectVideoSource(output.attachment, inspection);
                assert.equal(result.tracks.length, input.tracks.length);
                for (const [index, track] of result.tracks.entries()) {
                    const expected = input.tracks[index]!;
                    assert.equal(track.type, expected.type);
                    if (track.type === 'video' && expected.type === 'video') {
                        assert.equal(track.codec, 'avc');
                        assert.deepEqual(
                            [track.width, track.height, track.rotation],
                            [expected.width, expected.height, expected.rotation],
                        );
                    } else if (track.type === 'audio' && expected.type === 'audio') {
                        assert.equal(track.codec, 'aac');
                        assert.deepEqual(
                            [track.sampleRate, track.channels],
                            [expected.sampleRate, expected.channels],
                        );
                    }
                }
            } finally {
                await output.attachment.dispose();
            }
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    });
