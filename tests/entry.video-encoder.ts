import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {Readable, Writable} from 'node:stream';
import {runCodecProcess} from '../src/media/codec-process.ts';

await test('pinned OpenH264 encodes bounded synthetic frames to a decodable MP4', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-encoder-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const executable =
            process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
        const options = {
            limiter,
            executable,
            cpuSeconds: 10,
            memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
            maximumInputBytes: 1048576,
            maximumOutputBytes: 1048576,
            timeoutMs: 20000,
        };
        const raw = Buffer.alloc(64 * 48 * 3 * 6);
        for (let frame = 0; frame < 6; frame++)
            for (let y = 0; y < 48; y++)
                for (let x = 0; x < 64; x++) {
                    const pixel = (frame * 64 * 48 + y * 64 + x) * 3;
                    raw[pixel] = x * 4;
                    raw[pixel + 1] = y * 5;
                    raw[pixel + 2] = frame * 40;
                }
        const parts: Buffer[] = [];
        const result = await runCodecProcess(
            Readable.from([raw]),
            new Writable({
                write(chunk, _encoding, callback) {
                    parts.push(Buffer.from(chunk));
                    callback();
                },
            }),
            {
                ...options,
                args: [
                    '-hide_banner',
                    '-loglevel',
                    'error',
                    '-nostdin',
                    '-protocol_whitelist',
                    'pipe',
                    '-threads',
                    '1',
                    '-filter_threads',
                    '1',
                    '-f',
                    'rawvideo',
                    '-pixel_format',
                    'rgb24',
                    '-video_size',
                    '64x48',
                    '-framerate',
                    '6',
                    '-i',
                    'pipe:0',
                    '-an',
                    '-c:v',
                    'libopenh264',
                    '-pix_fmt',
                    'yuv420p',
                    '-threads',
                    '1',
                    '-b:v',
                    '200000',
                    '-movflags',
                    '+frag_keyframe+empty_moov+default_base_moof',
                    '-f',
                    'mp4',
                    'pipe:1',
                ],
            },
        );
        assert.equal(result.inputBytes, raw.length);
        const mp4 = Buffer.concat(parts);
        assert.equal(mp4.length, result.outputBytes);
        assert.equal(mp4.toString('ascii', 4, 8), 'ftyp');
        const metadata: Buffer[] = [];
        await runCodecProcess(
            Readable.from([mp4]),
            new Writable({
                write(chunk, _encoding, callback) {
                    metadata.push(Buffer.from(chunk));
                    callback();
                },
            }),
            {
                ...options,
                executable: join(dirname(executable), 'ffprobe'),
                args: [
                    '-v',
                    'error',
                    '-protocol_whitelist',
                    'pipe',
                    '-show_entries',
                    'stream=codec_name,codec_type,width,height',
                    '-of',
                    'json',
                    '-i',
                    'pipe:0',
                ],
            },
        );
        const streams = JSON.parse(Buffer.concat(metadata).toString()).streams;
        assert.equal(streams.length, 1);
        assert.deepEqual(streams[0], {
            codec_name: 'h264',
            codec_type: 'video',
            width: 64,
            height: 48,
        });
        let decodedBytes = 0;
        await runCodecProcess(
            Readable.from([mp4]),
            new Writable({
                write(chunk, _encoding, callback) {
                    decodedBytes += chunk.length;
                    callback();
                },
            }),
            {
                ...options,
                args: [
                    '-hide_banner',
                    '-loglevel',
                    'error',
                    '-nostdin',
                    '-xerror',
                    '-protocol_whitelist',
                    'pipe',
                    '-threads',
                    '1',
                    '-i',
                    'pipe:0',
                    '-map',
                    '0:v:0',
                    '-an',
                    '-c:v',
                    'rawvideo',
                    '-pix_fmt',
                    'yuv420p',
                    '-threads',
                    '1',
                    '-f',
                    'rawvideo',
                    'pipe:1',
                ],
            },
        );
        assert.equal(decodedBytes, ((64 * 48 * 3) / 2) * 6);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
