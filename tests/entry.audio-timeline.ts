import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {inspectAudioTimeline} from '../src/media/audio-timeline.ts';

await test('bounded FFprobe matches pinned Desktop source timelines for seven real containers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'real-audio-timeline-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const reference = JSON.parse(
            await readFile(new URL('./fixtures/audio-timelines.json', import.meta.url), 'utf8'),
        );
        assert.equal(reference.mediabunnyVersion, '1.34.4');
        assert.equal(reference.files.length, 7);
        for (const fixture of reference.files) {
            const bytes = Buffer.from(fixture.bytes, 'base64');
            assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
            const options = {
                limiter,
                executable: (
                    process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg'
                ).replace(/ffmpeg$/, 'ffprobe'),
                cpuSeconds: 2,
                memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                maximumInputBytes: 1048576,
                timeoutMs: 3000,
                maximumDurationSeconds: 2,
            };
            assert.equal(
                await inspectAudioTimeline(Readable.from([bytes]), options),
                fixture.durationSeconds,
                fixture.name,
            );
        }
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('packet timelines preserve rational timing and reject incomplete, excessive or interrupted inspection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audio-timeline-'));
    const limiter = join(directory, 'launcher'),
        executable = join(directory, 'probe');
    await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: 536870912,
        maximumInputBytes: 1024,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const transcript = async (body: string) =>
        writeFile(
            executable,
            `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(body)}));\n`,
            {mode: 0o700},
        );
    const run = () => inspectAudioTimeline(Readable.from([Buffer.from('synthetic')]), options);
    try {
        await transcript(
            'packet|stream_index=0|pts=12288|duration=736\nstream|index=0|time_base=1/48000\n',
        );
        assert.equal(await run(), 13024 / 48000);
        await transcript(
            'packet|stream_index=0|pts=-1024|duration=1024\npacket|stream_index=0|pts=0|duration=12000\npacket|stream_index=1|pts=24000|duration=12000\nstream|index=0|time_base=1/48000\nstream|index=1|time_base=1/48000\n',
        );
        assert.equal(await run(), 0.75);
        for (const body of [
            '',
            'packet|stream_index=0|pts=0|duration=12000\n',
            'packet|stream_index=0|pts=N/A|duration=12000\nstream|index=0|time_base=1/48000\n',
            'packet|stream_index=0|pts=0|duration=-1\nstream|index=0|time_base=1/48000\n',
            'packet|stream_index=0|pts=96000|duration=1\nstream|index=0|time_base=1/48000\n',
            'packet|stream_index=0|pts=-96001|duration=12000\nstream|index=0|time_base=1/48000\n',
            'packet|stream_index=0|pts=0|duration=12000\nstream|index=0|time_base=1/0\n',
            'packet|stream_index=0|pts=0|duration=12000\nstream|index=0|time_base=1/48000\nstream|index=0|time_base=1/48000\n',
            'x'.repeat(513),
        ]) {
            await transcript(body);
            await assert.rejects(run());
        }
        await transcript(
            'packet|stream_index=0|pts=0|duration=12000\nstream|index=0|time_base=1/48000\n',
        );
        await assert.rejects(inspectAudioTimeline(Readable.from([Buffer.alloc(1025)]), options));
        await assert.rejects(
            inspectAudioTimeline(
                Readable.from(
                    (async function* () {
                        yield Buffer.from('synthetic');
                        throw new Error('Source failed');
                    })(),
                ),
                options,
            ),
        );
        const signal = new AbortController(),
            stalled = new Readable({read() {}});
        const running = inspectAudioTimeline(stalled, {...options, signal: signal.signal});
        signal.abort();
        await assert.rejects(running);
        assert(stalled.destroyed);
        await assert.rejects(
            inspectAudioTimeline(new Readable({read() {}}), {...options, timeoutMs: 50}),
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
