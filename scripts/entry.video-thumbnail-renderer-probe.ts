import {deflateSync} from 'node:zlib';
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
const imageSource = readFileSync(join(desktop, 'src/common/dom/utils/image.ts'), 'utf8');
const uiSource = readFileSync(join(desktop, 'src/app/ui/modal/media-message/index.ts'), 'utf8');
const extract = (text: string, name: string) => {
    const parsed = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
    const node = parsed.statements.find(
        (node: any) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert(node);
    return node.getText(parsed);
};
const constants = readFileSync(join(desktop, 'src/common/network/protocol/constants.ts'), 'utf8');
assert(constants.includes('CSP_THUMBNAIL_MAX_SIZE = 512'));
assert(constants.includes('CSP_THUMBNAIL_QUALITY = 0.8'));
assert(constants.includes("CSP_VIDEO_THUMBNAIL_TYPE = 'image/jpeg'"));
const fixtures = JSON.parse(
    readFileSync(join(root, 'tests/fixtures/video-timelines.json'), 'utf8'),
).files;
const large = execFileSync(
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=6:duration=1',
        '-an',
        '-c:v',
        'libx264',
        '-bf',
        '0',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        'pipe:1',
    ],
    {timeout: 10000, maxBuffer: 1048576},
);
fixtures.push({
    name: 'avc-downsize',
    mime: 'video/mp4',
    bytes: large.toString('base64'),
    sha256: createHash('sha256').update(large).digest('hex'),
});
const later = execFileSync(
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x48:rate=6:duration=4',
        '-an',
        '-c:v',
        'libx264',
        '-bf',
        '0',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        'pipe:1',
    ],
    {timeout: 10000, maxBuffer: 1048576},
);
fixtures.push({
    name: 'avc-sample-later',
    mime: 'video/mp4',
    bytes: later.toString('base64'),
    sha256: createHash('sha256').update(later).digest('hex'),
});
const script = `
import {Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion, VideoSampleSink} from 'mediabunny';
const ensureArrayBufferBackedView = (bytes: Uint8Array) => Uint8Array.from(bytes);
const CSP_VIDEO_THUMBNAIL_TYPE = 'image/jpeg', CSP_THUMBNAIL_MAX_SIZE = 512, CSP_THUMBNAIL_QUALITY = 0.8;
const debugAssert = (value: unknown) => {if (!value) throw new Error('Assertion failed');};
const unwrap = (value: unknown) => {if (value == null) throw new Error('Missing value'); return value;};
const isSupportedImageType = (type: string) => ['image/jpeg','image/png','image/gif','image/webp','image/avif'].includes(type);
const isAlphaChannelSupported = (type: string) => ['image/png','image/gif','image/webp','image/avif'].includes(type);
// Every fixture is a video, so the UI's image-only branch is deliberately unavailable.
const mediaTypeToImageType = (type: string) => {if (!type.startsWith('video/')) throw new Error('Unexpected source type'); return undefined;};
const getThumbnailMediaType = () => {throw new Error('Unexpected image branch');};
${functions}
${extract(source, 'isVideoFileType')}
${extract(imageSource, 'downsizeImage')}
${extract(uiSource, 'generateThumbnail')}
globalThis.runVideoFixtures = async () => {
    const results = [];
    for (const fixture of ${JSON.stringify(fixtures)}) {
        const bytes = Uint8Array.from(atob(fixture.bytes), char => char.charCodeAt(0));
        const file = new File([bytes], fixture.name, {type: fixture.mime});
        const input = new Input({formats: ALL_FORMATS, source: new BlobSource(file)});
        const duration = await input.computeDuration();
        const track = await input.getPrimaryVideoTrack();
        let sampleTimestamp, selectedFrameRgba, selectedWidth, selectedHeight, colorSpace;
        for await (const frame of new VideoSampleSink(track).samples(duration * 0.1)) {
            colorSpace = {matrix: frame.colorSpace.matrix, primaries: frame.colorSpace.primaries, transfer: frame.colorSpace.transfer, fullRange: frame.colorSpace.fullRange};
            sampleTimestamp = frame.timestamp; selectedWidth = frame.displayWidth; selectedHeight = frame.displayHeight;
            const canvas = new OffscreenCanvas(selectedWidth, selectedHeight);
            const ctx = canvas.getContext('2d'); frame.draw(ctx, 0, 0); frame.close();
            selectedFrameRgba = Array.from(ctx.getImageData(0, 0, selectedWidth, selectedHeight).data);
            break;
        }
        const prepared = await generateThumbnail(file);
        if (!prepared) throw new Error('Thumbnail unavailable');
        const bitmap = await createImageBitmap(prepared.blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const rgba = Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        input.dispose();
        results.push({name: fixture.name, secureContext: globalThis.isSecureContext, videoDecoder: typeof globalThis.VideoDecoder, videoEncoder: typeof globalThis.VideoEncoder, duration, sampleTimestamp, colorSpace, selectedWidth, selectedHeight, selectedFrameRgba, originalDimensions: prepared.originalDimensions, resizedDimensions: prepared.resizedDimensions, mime: prepared.blob.type, bytes: Array.from(new Uint8Array(await prepared.blob.arrayBuffer())), rgba});
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
        desktopImageSourceSha256: createHash('sha256').update(imageSource).digest('hex'),
        desktopUiSourceSha256: createHash('sha256').update(uiSource).digest('hex'),
        fixtures,
    };
    writeFileSync(
        join(root, '.local/renderer-video-thumbnail-report.json'),
        JSON.stringify(artifact, null, 2) + '\n',
        {mode: 0o600},
    );
    if (process.argv.includes('--write-fixtures')) {
        const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
        const files = report.results.map((result: any, index: number) => {
            const fixture = fixtures[index];
            assert.equal(result.name, fixture.name);
            assert.equal(digest(Buffer.from(fixture.bytes, 'base64')), fixture.sha256);
            const jpeg = Buffer.from(result.bytes),
                rgba = Buffer.from(result.rgba),
                selected = Buffer.from(result.selectedFrameRgba);
            return {
                name: fixture.name,
                mime: fixture.mime,
                bytes: fixture.bytes,
                sha256: fixture.sha256,
                durationSeconds: result.duration,
                sampleTimestamp: result.sampleTimestamp,
                colorSpace: result.colorSpace,
                selectedWidth: result.selectedWidth,
                selectedHeight: result.selectedHeight,
                selectedRgbaDeflate: deflateSync(selected).toString('base64'),
                selectedRgbaSha256: digest(selected),
                width: result.resizedDimensions.width,
                height: result.resizedDimensions.height,
                jpeg: jpeg.toString('base64'),
                jpegSha256: digest(jpeg),
                rgbaDeflate: deflateSync(rgba).toString('base64'),
                rgbaSha256: digest(rgba),
            };
        });
        writeFileSync(
            join(root, 'tests/fixtures/video-thumbnails.json'),
            JSON.stringify(
                {
                    mediabunnyVersion: '1.34.4',
                    electronVersion: report.electron,
                    chromiumVersion: report.chromium,
                    desktopVideoSourceSha256: artifact.desktopVideoSourceSha256,
                    desktopImageSourceSha256: artifact.desktopImageSourceSha256,
                    desktopUiSourceSha256: artifact.desktopUiSourceSha256,
                    samplePercentage: 10,
                    jpegQuality: 0.8,
                    maximumSide: 512,
                    files,
                },
                null,
                2,
            ) + '\n',
        );
    }
    console.log(
        JSON.stringify(
            report.results.map(({bytes, rgba, selectedFrameRgba, ...result}: any) => ({
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
