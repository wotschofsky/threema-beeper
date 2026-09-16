import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {measureAudioDuration} from '../src/media/audio-duration.ts';
import {inspectAudioTimeline} from '../src/media/audio-timeline.ts';
import {prepareAudioAttachment} from '../src/media/audio-preparation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, '.local/sources/threema-desktop/apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const ts = require('typescript');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
assert.equal(require('electron/package.json').version, '40.10.0');
const source = readFileSync(join(desktop, 'src/common/utils/audio.ts'), 'utf8');
const aacTargetBitrate = require('mediabunny').QUALITY_HIGH._toAudioBitrate('aac');
assert.equal(aacTargetBitrate, 192000);
const ast = ts.createSourceFile('audio.ts', source, ts.ScriptTarget.Latest, true);
const names = [
    'transcodeAudioToMp4Aac',
    'transcodeAudioToMp4Opus',
    'transcodeAudioToMp4OutputFormat',
];
const declarations = ast.statements.filter(
    (node: any) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text),
);
assert.equal(declarations.length, names.length);
const functions = declarations.map((node: any) => node.getText(ast)).join('\n');
const reference = JSON.parse(
    readFileSync(join(root, 'tests/fixtures/audio-timelines.json'), 'utf8'),
);
const script = `
import {Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion} from 'mediabunny';
const ensureArrayBufferBackedView = (bytes: Uint8Array) => Uint8Array.from(bytes);
${functions}
globalThis.runAudioFixtures = async () => {
    const results = [];
    for (const fixture of ${JSON.stringify(reference.files)}) {
        const bytes = Uint8Array.from(atob(fixture.bytes), char => char.charCodeAt(0));
        const diagnostics = [];
        const log = {debug: (...messages) => diagnostics.push(messages.map(String).join(' '))};
        let codec = 'aac';
        let converted = await transcodeAudioToMp4Aac(bytes, 'audio/mp4', log);
        if (!converted) { codec = 'opus'; converted = await transcodeAudioToMp4Opus(bytes, 'audio/mp4', log); }
        results.push({name: fixture.name, codec: converted ? codec : 'original',
            secureContext: globalThis.isSecureContext,
            audioDecoder: typeof globalThis.AudioDecoder, audioEncoder: typeof globalThis.AudioEncoder,
            duration: converted?.duration, bytes: converted ? Array.from(converted.buffer) : undefined, diagnostics});
    }
    return results;
};`;
const bundled = esbuild.buildSync({
    stdin: {contents: script, loader: 'ts', resolveDir: desktop},
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
}).outputFiles[0].text;
const directory = mkdtempSync(join(tmpdir(), 'audio-renderer-'));
try {
    const request = join(directory, 'request.json'),
        output = join(directory, 'output.json');
    writeFileSync(
        request,
        JSON.stringify({secureContext: true, code: `${bundled}\nglobalThis.runAudioFixtures()`}),
        {mode: 0o600},
    );
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
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.electron, '40.10.0');
    assert.equal(report.chromium, '144.0.7559.236');
    assert(
        report.results.every(
            (result: any) =>
                result.secureContext &&
                result.audioDecoder === 'function' &&
                result.audioEncoder === 'function',
        ),
    );
    const limiter = join(directory, 'launcher');
    writeFileSync(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const executable = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: 536870912,
        maximumInputBytes: 1048576,
        maximumOutputBytes: 1048576,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const inspect = async (bytes: Buffer) => ({
        streams: JSON.parse(
            execFileSync(
                executable.replace(/ffmpeg$/, 'ffprobe'),
                [
                    '-v',
                    'error',
                    '-show_entries',
                    'stream=index,codec_name,codec_type,sample_rate,channels',
                    '-of',
                    'json',
                    '-i',
                    'pipe:0',
                ],
                {input: bytes, timeout: 3000, maxBuffer: 65536},
            ).toString(),
        ).streams,
        timeline: await inspectAudioTimeline(Readable.from([bytes]), {
            ...options,
            executable: executable.replace(/ffmpeg$/, 'ffprobe'),
        }),
        decoded: await measureAudioDuration(Readable.from([bytes]), options),
    });
    const comparisons = [];
    for (const rendered of report.results) {
        const fixture = reference.files.find((item: any) => item.name === rendered.name);
        const bytes = Buffer.from(fixture.bytes, 'base64');
        const native = await prepareAudioAttachment(
            {bytes: bytes.length, stream: () => Readable.from([bytes]), dispose: async () => {}},
            directory,
            options,
        );
        try {
            const chunks = [];
            for await (const chunk of native.attachment.stream()) chunks.push(Buffer.from(chunk));
            comparisons.push({
                name: rendered.name,
                codec: rendered.codec,
                desktopDuration: rendered.duration,
                nativeDuration: native.metadata.durationSeconds,
                desktopOutput: rendered.bytes
                    ? await inspect(Buffer.from(rendered.bytes))
                    : undefined,
                nativeOutput: await inspect(Buffer.concat(chunks)),
            });
        } finally {
            await native.attachment.dispose();
        }
    }
    writeFileSync(
        join(root, '.local/renderer-audio-report.json'),
        JSON.stringify(
            {
                ...report,
                desktopAudioSourceSha256: createHash('sha256').update(source).digest('hex'),
                aacTargetBitrate,
                comparisons,
            },
            null,
            2,
        ) + '\n',
        {mode: 0o600},
    );
    console.log(JSON.stringify(comparisons, null, 2));
} finally {
    rmSync(directory, {recursive: true, force: true});
}
