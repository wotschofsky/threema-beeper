import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {measureAudioDuration} from '../src/media/audio-duration.ts';

await test('audio duration comes from decoded samples with bounded failure and cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-audio-duration-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        maximumInputBytes: 1048576,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const fixture = (
        rate: number,
        channels: number,
        duration: number,
        codec: string,
        format: string,
    ) => {
        const bytes = execFileSync(
            executable,
            [
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                `sine=frequency=440:sample_rate=${rate}:duration=${duration}`,
                '-ac',
                String(channels),
                '-c:a',
                codec,
                '-f',
                format,
                'pipe:1',
            ],
            {timeout: 3000, maxBuffer: 1048576},
        );
        if (format === 'wav') {
            // FFmpeg cannot finalize RIFF lengths on a pipe. Produce an ordinary finite WAV.
            bytes.writeUInt32LE(bytes.length - 8, 4);
            let offset = 12;
            while (bytes.toString('ascii', offset, offset + 4) !== 'data') {
                const length = bytes.readUInt32LE(offset + 4);
                offset += 8 + length + (length % 2);
                assert(offset + 8 <= bytes.length);
            }
            bytes.writeUInt32LE(bytes.length - offset - 8, offset + 4);
        }
        return bytes;
    };
    try {
        for (const [rate, channels, codec, format] of [
            [48000, 1, 'pcm_s16le', 'wav'],
            [44100, 2, 'pcm_s16le', 'wav'],
            [48000, 2, 'flac', 'flac'],
        ] as const) {
            const bytes = fixture(rate, channels, 0.25, codec, format);
            assert.deepEqual(await measureAudioDuration(Readable.from([bytes]), options), {
                durationSeconds: 0.25,
                decodedSamples: 12000,
            });
        }
        const bytes = fixture(48000, 1, 0.25, 'pcm_s16le', 'wav');
        await assert.rejects(
            measureAudioDuration(Readable.from([Buffer.from('not audio')]), options),
        );
        await assert.rejects(
            measureAudioDuration(Readable.from([fixture(48000, 1, 1.1, 'pcm_s16le', 'wav')]), {
                ...options,
                maximumDurationSeconds: 1,
            }),
        );
        await assert.rejects(
            measureAudioDuration(Readable.from([bytes]), {...options, maximumInputBytes: 1}),
        );
        await assert.rejects(
            measureAudioDuration(Readable.from([bytes]), {
                ...options,
                maximumDurationSeconds: 10001,
            }),
        );
        const lateFailure = Readable.from(
            (async function* () {
                yield bytes;
                throw new Error('Late authentication failure');
            })(),
        );
        await assert.rejects(measureAudioDuration(lateFailure, options));
        const abort = new AbortController();
        const stalled = new Readable({read() {}});
        const pending = measureAudioDuration(stalled, {...options, signal: abort.signal});
        abort.abort();
        await assert.rejects(pending);
        assert(stalled.destroyed);
        const timedOut = new Readable({read() {}});
        await assert.rejects(measureAudioDuration(timedOut, {...options, timeoutMs: 50}));
        assert(timedOut.destroyed);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
