import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {prepareVideoAttachment} from '../src/media/video-preparation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
    join(root, '.local/sources/threema-desktop/apps/desktop/package.json'),
);
const directory = await mkdtemp(join(tmpdir(), 'video-playback-'));
try {
    const supplied =
        process.argv[2] === '--fixtures'
            ? JSON.parse(await readFile(process.argv[3]!, 'utf8'))
            : undefined;
    const fixtures: {
        name: string;
        bytes: string;
        sha256: string;
        width: number;
        height: number;
        sourceDuration: number;
        audio: boolean;
    }[] = [];
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const producer = supplied?.producer ?? {
        platform: process.platform,
        arch: process.arch,
        ffmpeg: execFileSync(executable, ['-version']).toString().split('\n')[0],
    };
    if (supplied) fixtures.push(...supplied.fixtures);
    else {
        const references = JSON.parse(
            await readFile(join(root, 'tests/fixtures/video-timelines.json'), 'utf8'),
        );
        const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        for (const fixture of references.files) {
            const bytes = Buffer.from(fixture.bytes, 'base64');
            assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
            const prepared = await prepareVideoAttachment(
                {
                    bytes: bytes.length,
                    read: async (start, end) => Buffer.from(bytes.subarray(start, end)),
                    stream: () => Readable.from([bytes]),
                    dispose: async () => {},
                },
                directory,
                {
                    codec: {
                        limiter,
                        executable,
                        cpuSeconds: 10,
                        memoryBytes: Number(
                            process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912,
                        ),
                        maximumInputBytes: 1048576,
                        maximumOutputBytes: 1048576,
                        timeoutMs: 15000,
                    },
                    inspection: {
                        limiter,
                        executable: process.execPath,
                        cpuSeconds: 5,
                        memoryBytes: Number(
                            process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368,
                        ),
                        timeoutMs: 10000,
                        maximumDurationSeconds: 3,
                        maximumReadBytes: 1048576,
                    },
                },
            );
            try {
                const output = await prepared.attachment.read(0, prepared.attachment.bytes);
                fixtures.push({
                    name: fixture.name,
                    bytes: output.toString('base64'),
                    sha256: createHash('sha256').update(output).digest('hex'),
                    width: prepared.metadata.width,
                    height: prepared.metadata.height,
                    sourceDuration: prepared.metadata.durationSeconds,
                    audio: fixture.name === 'avc-aac',
                });
            } finally {
                await prepared.attachment.dispose();
            }
        }
    }
    assert.equal(fixtures.length, 4);
    for (const fixture of fixtures)
        assert.equal(
            createHash('sha256').update(Buffer.from(fixture.bytes, 'base64')).digest('hex'),
            fixture.sha256,
        );
    if (process.argv[2] === '--generate-only') console.log(JSON.stringify({producer, fixtures}));
    else {
        assert.equal(require('electron/package.json').version, '40.10.0');
        const code = `(async () => {
            const results = [];
            for (const fixture of ${JSON.stringify(fixtures)}) {
                const bytes = Uint8Array.from(atob(fixture.bytes), char => char.charCodeAt(0));
                const video = document.createElement('video'); video.muted = true; video.playsInline = true;
                document.body.append(video);
                const url = URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'}));
                const result = {name: fixture.name};
                try {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => {video.pause(); reject(new Error('Playback timeout'));}, 8000);
                        video.onended = () => {clearTimeout(timer); resolve();};
                        video.onerror = () => {clearTimeout(timer); reject(new Error('Media error ' + video.error?.code));};
                        video.src = url;
                        video.play().catch(error => {clearTimeout(timer); reject(error);});
                    });
                    result.ended = video.ended; result.duration = video.duration;
                    result.width = video.videoWidth; result.height = video.videoHeight;
                    result.frames = video.getVideoPlaybackQuality().totalVideoFrames;
                    if (fixture.audio) {
                        const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer.slice(0));
                        result.audioDuration = audio.duration; let peak = 0;
                        for (const sample of audio.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
                        result.audioPeak = peak;
                    }
                } catch(error) {result.error = String(error);}
                finally {video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);}
                results.push(result);
            }
            return results;
        })()`;
        const request = join(directory, 'request.json'),
            output = join(directory, 'output.json');
        await writeFile(request, JSON.stringify({secureContext: true, code}), {mode: 0o600});
        const env = {...process.env};
        delete env.ELECTRON_RUN_AS_NODE;
        execFileSync(
            require('electron'),
            [
                join(root, 'scripts/image-renderer-worker.cjs'),
                request,
                output,
                join(directory, 'profile'),
            ],
            {env, timeout: 45000, stdio: ['ignore', 'pipe', 'pipe']},
        );
        const report = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(report.electron, '40.10.0');
        assert.equal(report.chromium, '144.0.7559.236');
        await writeFile(
            process.argv[4] ?? join(root, '.local/video-playback-report.json'),
            JSON.stringify(
                {...report, producer, fixtures: fixtures.map(({bytes, ...metadata}) => metadata)},
                null,
                2,
            ) + '\n',
        );
        console.log(JSON.stringify(report.results, null, 2));
        assert.equal(report.results.length, fixtures.length);
        for (const [index, result] of report.results.entries()) {
            const fixture = fixtures[index]!;
            assert.equal(result.error, undefined, fixture.name);
            assert.equal(result.ended, true);
            assert.equal(result.width, fixture.width);
            assert.equal(result.height, fixture.height);
            assert(result.frames > 0);
            assert(result.duration > 0 && result.duration < 3);
            if (fixture.audio)
                assert(
                    result.audioPeak > 0 && result.audioDuration > 0 && result.audioDuration < 3,
                );
        }
    }
} finally {
    await rm(directory, {recursive: true, force: true});
}
