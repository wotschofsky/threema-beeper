import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {prepareAudioAttachment, prepareOpusAttachment} from '../src/media/audio-preparation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
    join(root, '.local/sources/threema-desktop/apps/desktop/package.json'),
);

const references = JSON.parse(
    await readFile(join(root, 'tests/fixtures/audio-timelines.json'), 'utf8'),
);
const directory = await mkdtemp(join(tmpdir(), 'audio-playback-'));
try {
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const options = {
        limiter,
        executable:
            process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        maximumInputBytes: 1048576,
        maximumOutputBytes: 1048576,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const supplied =
        process.argv[2] === '--fixtures'
            ? JSON.parse(await readFile(process.argv[3]!, 'utf8'))
            : undefined;
    const fixtures: {
        name: string;
        codec: string;
        sourceDuration: number;
        sha256: string;
        bytes: string;
    }[] = [];
    if (supplied) fixtures.push(...supplied.fixtures);
    else
        for (const fixture of references.files) {
            const bytes = Buffer.from(fixture.bytes, 'base64');
            assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
            for (const [codec, prepare] of [
                ['aac', prepareAudioAttachment],
                ['opus', prepareOpusAttachment],
            ] as const) {
                const prepared = await prepare(
                    {
                        bytes: bytes.length,
                        stream: () => Readable.from([bytes]),
                        dispose: async () => {},
                    },
                    directory,
                    options,
                );
                try {
                    const chunks = [];
                    for await (const chunk of prepared.attachment.stream())
                        chunks.push(Buffer.from(chunk));
                    const encoded = Buffer.concat(chunks);
                    fixtures.push({
                        name: fixture.name,
                        codec,
                        sourceDuration: prepared.metadata.durationSeconds,
                        sha256: createHash('sha256').update(encoded).digest('hex'),
                        bytes: encoded.toString('base64'),
                    });
                } finally {
                    await prepared.attachment.dispose();
                }
            }
        }
    const producer = supplied?.producer ?? {
        platform: process.platform,
        architecture: process.arch,
        codecVersion: execFileSync(options.executable, ['-version'], {encoding: 'utf8'}).split(
            '\n',
        )[0],
    };
    assert.equal(fixtures.length, 14);
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
            const result = {name: fixture.name, codec: fixture.codec};
            try {
                const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer.slice(0));
                result.decodedDuration = decoded.duration; result.channels = decoded.numberOfChannels;
                let peak = 0; for (const sample of decoded.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
                result.peak = peak;
            } catch (error) { result.decodeError = String(error); }
            const audio = document.createElement('audio'); audio.muted = true; audio.preload = 'metadata';
            const url = URL.createObjectURL(new Blob([bytes], {type: 'audio/mp4'}));
            try {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Metadata timeout')), 3000);
                    audio.onloadedmetadata = () => {clearTimeout(timer); resolve();};
                    audio.onerror = () => {clearTimeout(timer); reject(new Error('Media error ' + audio.error?.code));};
                    audio.src = url; audio.load();
                });
                result.elementDuration = Number.isFinite(audio.duration) ? audio.duration : String(audio.duration);
            } catch (error) { result.elementError = String(error); }
            finally { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
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
            {env, timeout: 35000, stdio: ['ignore', 'pipe', 'pipe']},
        );
        const report = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(report.electron, '40.10.0');
        assert.equal(report.chromium, '144.0.7559.236');
        await writeFile(
            process.argv[4] ?? join(root, '.local/audio-playback-report.json'),
            JSON.stringify(
                {
                    ...report,
                    producer,
                    fixtures: fixtures.map(({bytes, ...metadata}) => metadata),
                },
                null,
                2,
            ) + '\n',
        );
        console.log(JSON.stringify(report.results, null, 2));
        assert.equal(report.results.length, 14);
        for (const result of report.results) {
            assert.equal(result.decodeError, undefined, result.name + '/' + result.codec);
            assert.equal(result.elementError, undefined, result.name + '/' + result.codec);
            assert(result.decodedDuration > 0 && result.decodedDuration < 2 && result.peak > 0);
            assert(
                typeof result.elementDuration === 'number' &&
                    result.elementDuration > 0 &&
                    result.elementDuration < 2,
                result.name + '/' + result.codec + ' has invalid media duration',
            );
        }
    }
} finally {
    await rm(directory, {recursive: true, force: true});
}
