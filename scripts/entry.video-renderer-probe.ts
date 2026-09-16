import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Synthetic fixtures only. Never opens a Threema profile or connects an account.
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, '.local/sources/threema-desktop/apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const ts = require('typescript');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
assert.equal(require('electron/package.json').version, '40.10.0');
assert.equal(
    JSON.parse(readFileSync(join(desktop, 'node_modules/mediabunny/package.json'), 'utf8')).version,
    '1.34.4',
);
const source = readFileSync(join(desktop, 'src/common/utils/video.ts'), 'utf8');
const ast = ts.createSourceFile('video.ts', source, ts.ScriptTarget.Latest, true);
const names = [
    'createMp4ConversionInit',
    'validateConvertibility',
    'generateVideoThumbnail',
    'transcodeVideoToMp4H264',
];
const declarations = ast.statements.filter(
    (node: any) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text),
);
assert.equal(declarations.length, names.length);
const functions = declarations.map((node: any) => node.getText(ast)).join('\n');
const executable = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const fixtures = [
    {name: 'avc', mime: 'video/mp4', audio: false, webm: false, noBFrames: false},
    {name: 'avc-aac', mime: 'video/mp4', audio: true, webm: false, noBFrames: false},
    {name: 'avc-no-bframes', mime: 'video/mp4', audio: false, webm: false, noBFrames: true},
    {name: 'vp9', mime: 'video/webm', audio: false, webm: true, noBFrames: false},
].map((fixture) => {
    const bytes = execFileSync(
        executable,
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=64x48:rate=6:duration=1',
            ...(fixture.audio
                ? [
                      '-f',
                      'lavfi',
                      '-i',
                      'sine=frequency=440:sample_rate=48000:duration=1',
                      '-c:a',
                      'aac',
                  ]
                : ['-an']),
            '-c:v',
            fixture.webm ? 'libvpx-vp9' : 'libx264',
            '-threads',
            '1',
            '-pix_fmt',
            'yuv420p',
            ...(fixture.noBFrames ? ['-bf', '0'] : []),
            ...(fixture.webm
                ? ['-f', 'webm']
                : ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4']),
            'pipe:1',
        ],
        {timeout: 10000, maxBuffer: 1048576},
    );
    return {
        name: fixture.name,
        mime: fixture.mime,
        bytes: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
});
const script = `
import {Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion, VideoSampleSink} from 'mediabunny';
const ensureArrayBufferBackedView = (bytes: Uint8Array) => Uint8Array.from(bytes);
${functions}
globalThis.runVideoFixtures = async () => {
    const results = [];
    for (const fixture of ${JSON.stringify(fixtures)}) {
        const bytes = Uint8Array.from(atob(fixture.bytes), char => char.charCodeAt(0));
        const diagnostics = [];
        const log = {debug: (...messages) => diagnostics.push(messages.map(String).join(' '))};
        const input = new Input({formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes], {type: fixture.mime}))});
        const sourceDuration = await input.computeDuration();
        const sourceStart = await input.getFirstTimestamp();
        const converted = await transcodeVideoToMp4H264(bytes, fixture.mime, log);
        const thumbnail = await generateVideoThumbnail(new File([bytes], fixture.name, {type: fixture.mime}), 'image/jpeg', 0.8, 0, log);
        let outputTracks, outputDuration;
        if (converted) {
            const output = new Input({formats: ALL_FORMATS, source: new BlobSource(new Blob([converted.buffer], {type: 'video/mp4'}))});
            outputDuration = await output.computeDuration();
            outputTracks = await Promise.all((await output.getTracks()).map(async track => ({type: track.type, codec: track.codec, firstTimestamp: await track.getFirstTimestamp()})));
            output.dispose();
        }
        input.dispose();
        results.push({name: fixture.name, secureContext: globalThis.isSecureContext, videoDecoder: typeof globalThis.VideoDecoder, videoEncoder: typeof globalThis.VideoEncoder, sourceDuration, sourceStart, duration: converted?.duration, bytes: converted ? Array.from(converted.buffer) : undefined, thumbnailBytes: thumbnail?.size, outputDuration, outputTracks, diagnostics});
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
const directory = mkdtempSync(join(tmpdir(), 'video-renderer-'));
try {
    const request = join(directory, 'request.json'),
        output = join(directory, 'output.json');
    writeFileSync(
        request,
        JSON.stringify({secureContext: true, code: `${bundled}\nglobalThis.runVideoFixtures()`}),
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
    assert.equal(report.results.length, fixtures.length);
    assert(
        report.results.every(
            (result: any) =>
                result.secureContext &&
                result.videoDecoder === 'function' &&
                result.videoEncoder === 'function',
        ),
    );
    const artifact = {
        ...report,
        desktopVideoSourceSha256: createHash('sha256').update(source).digest('hex'),
        fixtures,
    };
    writeFileSync(
        join(root, '.local/renderer-video-report.json'),
        JSON.stringify(artifact, null, 2) + '\n',
        {mode: 0o600},
    );
    console.log(
        JSON.stringify(
            report.results.map(({bytes, ...result}: any) => ({
                ...result,
                outputBytes: bytes?.length,
            })),
            null,
            2,
        ),
    );
} finally {
    rmSync(directory, {recursive: true, force: true});
}
