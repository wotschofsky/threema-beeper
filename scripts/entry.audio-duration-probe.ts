import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {measureAudioDuration} from '../src/media/audio-duration.ts';
import {inspectAudioTimeline} from '../src/media/audio-timeline.ts';

// Synthetic diagnostic only. Desktop uses this pinned demuxer after conversion;
// this measures its source-timeline result without claiming browser encoder parity.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
    join(root, '.local/sources/threema-desktop/apps/desktop/package.json'),
);
const {Input, ALL_FORMATS, BlobSource} = require('mediabunny');
const manifest = JSON.parse(
    await readFile(
        join(
            root,
            '.local/sources/threema-desktop/apps/desktop/node_modules/mediabunny/package.json',
        ),
        'utf8',
    ),
);
assert.equal(manifest.version, '1.34.4');
const source = await readFile(
    join(root, '.local/sources/threema-desktop/apps/desktop/src/common/utils/audio.ts'),
);
const directory = await mkdtemp(join(tmpdir(), 'audio-timeline-probe-'));
const executable = process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
const cases = [
    {
        name: 'wav-44100',
        extension: 'wav',
        mime: 'audio/wav',
        args: ['-ar', '44100', '-c:a', 'pcm_s16le'],
    },
    {name: 'flac', extension: 'flac', mime: 'audio/flac', args: ['-c:a', 'flac']},
    {name: 'aac-mp4', extension: 'm4a', mime: 'audio/mp4', args: ['-c:a', 'aac']},
    {
        name: 'aac-fragmented',
        extension: 'm4a',
        mime: 'audio/mp4',
        args: ['-c:a', 'aac', '-movflags', '+frag_keyframe+empty_moov+default_base_moof'],
    },
    {
        name: 'aac-offset',
        extension: 'm4a',
        mime: 'audio/mp4',
        args: ['-af', 'asetpts=PTS+0.5/TB', '-c:a', 'aac'],
    },
    {
        name: 'aac-gap',
        extension: 'm4a',
        mime: 'audio/mp4',
        args: ['-af', "asetpts='PTS+gte(T,0.1)*0.5/TB'", '-c:a', 'aac'],
    },
    {
        name: 'aac-two-tracks',
        extension: 'm4a',
        mime: 'audio/mp4',
        args: [
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=880:sample_rate=48000:duration=0.75',
            '-map',
            '0:a',
            '-map',
            '1:a',
            '-c:a',
            'aac',
        ],
    },
];
try {
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const results = [];
    const referenceFiles = [];
    for (const fixture of cases) {
        const filename = join(directory, `${fixture.name}.${fixture.extension}`);
        execFileSync(
            executable,
            [
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:sample_rate=48000:duration=0.25',
                ...fixture.args,
                filename,
            ],
            {timeout: 5000},
        );
        const bytes = await readFile(filename);
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BlobSource(new Blob([Uint8Array.from(bytes)], {type: fixture.mime})),
        });
        let desktopDuration: number;
        try {
            desktopDuration = await input.computeDuration();
        } finally {
            input.dispose();
        }
        referenceFiles.push({
            name: fixture.name,
            bytes: bytes.toString('base64'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            durationSeconds: desktopDuration,
        });
        const native = await measureAudioDuration(Readable.from([bytes]), {
            executable,
            limiter,
            cpuSeconds: 2,
            memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
            maximumInputBytes: 1048576,
            timeoutMs: 3000,
            maximumDurationSeconds: 2,
        });
        results.push({
            name: fixture.name,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            desktopDuration,
            ...native,
            differenceSeconds: native.durationSeconds - desktopDuration,
            packetTimelineSeconds: await inspectAudioTimeline(Readable.from([bytes]), {
                executable: join(dirname(executable), 'ffprobe'),
                limiter,
                cpuSeconds: 2,
                memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                maximumInputBytes: 1048576,
                timeoutMs: 3000,
                maximumDurationSeconds: 2,
            }),
        });
    }
    const report = {
        mediabunnyVersion: manifest.version,
        desktopAudioSourceSha256: createHash('sha256').update(source).digest('hex'),
        results,
    };
    for (const result of results)
        assert.equal(result.packetTimelineSeconds, result.desktopDuration, result.name);
    await writeFile(
        join(root, '.local/audio-duration-report.json'),
        JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--write-fixtures'))
        await writeFile(
            join(root, 'tests/fixtures/audio-timelines.json'),
            JSON.stringify(
                {
                    mediabunnyVersion: manifest.version,
                    desktopAudioSourceSha256: report.desktopAudioSourceSha256,
                    files: referenceFiles,
                },
                null,
                2,
            ) + '\n',
        );
} finally {
    await rm(directory, {recursive: true, force: true});
}
