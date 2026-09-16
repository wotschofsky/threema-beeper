import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
    join(root, '.local/sources/threema-desktop/apps/desktop/package.json'),
);
assert.equal(require('electron/package.json').version, '40.10.0');
const source = readFileSync(
    join(root, '.local/sources/threema-desktop/apps/desktop/src/common/dom/utils/image.ts'),
    'utf8',
);
const ts =
    require('typescript') as typeof import('../.local/sources/threema-desktop/node_modules/typescript/lib/typescript.js');
const ast = ts.createSourceFile('image.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'downsizeImage',
);
assert(declaration);
const resize = ts.transpileModule(declaration.getText(ast).replace('export ', ''), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
}).outputText;
const fixtures = ['gradient', 'checker', 'alpha-edge', 'coordinates'].flatMap((name) =>
    [32, 17].map((width) => ({
        name: `${name}-${width}`,
        width,
        height: width === 32 ? 32 : 13,
        rgba: Array.from({length: width * (width === 32 ? 32 : 13)}, (_, index) => {
            const x = index % width,
                y = Math.floor(index / width);
            if (name === 'coordinates') return [x * 7, y * 7, 0, 255];
            if (name === 'checker') return [((x + y) % 2) * 255, (x % 2) * 255, (y % 2) * 255, 255];
            if (name === 'alpha-edge') return x < width / 2 ? [255, 0, 0, 0] : [0, 64, 255, 128];
            return [(x * 71 + y * 13) % 256, (x * 17 + y * 91) % 256, (x * 47 + y * 29) % 256, 255];
        }).flat(),
    })),
);
const code = `(async () => {
    const unwrap = value => {if (value == null) throw Error('Missing canvas'); return value;};
    const debugAssert = value => {if (!value) throw Error('Invalid dimensions');};
    const isSupportedImageType = type => type === 'image/png';
    const isAlphaChannelSupported = () => true;
    ${resize}
    const results = [];
    for (const fixture of ${JSON.stringify(fixtures)}) {
        const input = new OffscreenCanvas(fixture.width, fixture.height);
        input.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(fixture.rgba), fixture.width, fixture.height), 0, 0);
        const file = await input.convertToBlob({type: 'image/png'});
        const decoded = await createImageBitmap(file);
        const decodedCanvas = new OffscreenCanvas(decoded.width, decoded.height);
        decodedCanvas.getContext('2d').drawImage(decoded, 0, 0);
        decoded.close();
        const decodedSource = Array.from(decodedCanvas.getContext('2d').getImageData(0, 0, decodedCanvas.width, decodedCanvas.height).data);
        for (const side of [16, 8, 4, 1]) {
            const prepared = await downsizeImage(file, 'image/png', side, 0.85);
            if (!prepared) throw Error('Fixture failed');
            const bitmap = await createImageBitmap(prepared.resized);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0); bitmap.close();
            const modes = [];
            for (const quality of ['low', 'medium', 'high']) {
                const original = await createImageBitmap(file);
                const target = new OffscreenCanvas(canvas.width, canvas.height);
                const ctx = target.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = quality;
                ctx.drawImage(original, 0, 0, target.width, target.height);
                original.close();
                modes.push({quality, rgba: Array.from(ctx.getImageData(0, 0, target.width, target.height).data)});
            }
            results.push({name: fixture.name, side, width: canvas.width, height: canvas.height,
                modes, decodedSource,
                rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)});
        }
    }
    return results;
})()`;
const temporary = mkdtempSync(join(tmpdir(), 'bridge-resize-fixtures-'));
try {
    const request = join(temporary, 'request.json'),
        output = join(temporary, 'output.json');
    writeFileSync(request, JSON.stringify({code}), {mode: 0o600});
    const environment = {...process.env};
    delete environment.ELECTRON_RUN_AS_NODE;
    execFileSync(
        require('electron') as string,
        [
            join(root, 'scripts/image-renderer-worker.cjs'),
            request,
            output,
            join(temporary, 'profile'),
        ],
        {env: environment, timeout: 35000, stdio: ['ignore', 'pipe', 'pipe']},
    );
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
        electron: string;
        chromium: string;
        results: {
            name: string;
            side: number;
            width: number;
            height: number;
            rgba: number[];
            decodedSource: number[];
            modes: {quality: 'low' | 'medium' | 'high'; rgba: number[]}[];
        }[];
    };
    assert.equal(report.electron, '40.10.0');
    assert.equal(report.chromium, '144.0.7559.236');
    for (const result of report.results) {
        const fixture = fixtures.find((item) => item.name === result.name)!;
        if (!fixture.name.startsWith('alpha-edge')) {
            assert.deepEqual(
                result.decodedSource,
                fixture.rgba,
                'Opaque fixture pixels must survive renderer PNG decoding unchanged',
            );
        }
        assert.deepEqual(
            result.modes.find((mode) => mode.quality === 'medium')?.rgba,
            result.rgba,
            'Direct medium sampling must match the actual Desktop function output',
        );
    }
    const comparisons = report.results.map((result) => {
        const fixture = fixtures.find((item) => item.name === result.name)!;
        const filters = ['bicubic', 'bilinear', 'area', 'lanczos'].map((kernel) => {
            const rgba = execFileSync(
                process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
                [
                    '-v',
                    'error',
                    '-threads',
                    '1',
                    '-filter_threads',
                    '1',
                    '-f',
                    'rawvideo',
                    '-pix_fmt',
                    'rgba',
                    '-s',
                    `${fixture.width}x${fixture.height}`,
                    '-i',
                    'pipe:0',
                    '-frames:v',
                    '1',
                    '-vf',
                    `scale=${result.width}:${result.height}:flags=${kernel}`,
                    '-pix_fmt',
                    'rgba',
                    '-f',
                    'rawvideo',
                    'pipe:1',
                ],
                {input: Buffer.from(fixture.rgba), timeout: 3000, maxBuffer: 65536},
            );
            assert.equal(rgba.length, result.rgba.length);
            const errors = result.rgba.map((value, index) => Math.abs(value - rgba[index]!));
            const visibleErrors = result.rgba.map((value, index) => {
                if (index % 4 === 3) return Math.abs(value - rgba[index]!);
                const alphaIndex = index - (index % 4) + 3;
                return Math.abs(
                    Math.round((value * result.rgba[alphaIndex]!) / 255) -
                        Math.round((rgba[index]! * rgba[alphaIndex]!) / 255),
                );
            });
            return {
                kernel,
                maximumError: Math.max(...errors),
                meanError: errors.reduce((a, b) => a + b, 0) / errors.length,
                maximumVisibleError: Math.max(...visibleErrors),
                meanVisibleError: visibleErrors.reduce((a, b) => a + b, 0) / visibleErrors.length,
            };
        });
        return {name: result.name, side: result.side, filters};
    });
    writeFileSync(
        join(root, '.local/renderer-resize-report.json'),
        JSON.stringify(
            {
                sourceSha256: createHash('sha256').update(source).digest('hex'),
                ...report,
                fixtures,
                comparisons,
            },
            null,
            2,
        ) + '\n',
        {mode: 0o600},
    );
    for (const name of ['gradient', 'checker', 'alpha-edge']) {
        const relevant = comparisons.filter((item) => item.name.startsWith(name));
        console.log(
            name,
            ['bicubic', 'bilinear', 'area', 'lanczos'].map((kernel) => ({
                kernel,
                maximumError: Math.max(
                    ...relevant.flatMap((item) =>
                        item.filters.filter((f) => f.kernel === kernel).map((f) => f.maximumError),
                    ),
                ),
                meanError:
                    relevant.reduce(
                        (sum, item) =>
                            sum + item.filters.find((f) => f.kernel === kernel)!.meanError,
                        0,
                    ) / relevant.length,
            })),
        );
    }
} finally {
    rmSync(temporary, {recursive: true, force: true});
}
