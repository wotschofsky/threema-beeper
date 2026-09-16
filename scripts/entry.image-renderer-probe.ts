import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    avifGrid,
    avifAnimation,
    avifWideGamut,
    avifCicpP3,
    avifCicpLinear,
    avifCicpBt709,
    avifLinear10,
    avifLinear12,
    avifHdrPq,
    avifHdrHlg,
    avifHdrPqClli,
    avifHdrPqAlpha,
    avifHdrHlgAlpha,
} from '../tests/fixtures/avif-grid.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
    join(root, '.local/sources/threema-desktop/apps/desktop/package.json'),
);
const ts =
    require('typescript') as typeof import('../.local/sources/threema-desktop/node_modules/typescript/lib/typescript.js');
assert.equal(require('electron/package.json').version, '40.10.0');
const source = readFileSync(
    join(root, '.local/sources/threema-desktop/apps/desktop/src/common/dom/utils/image.ts'),
    'utf8',
);
const ast = ts.createSourceFile('image.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'downsizeImage',
);
assert(declaration);
const resize = ts.transpileModule(declaration.getText(ast).replace('export ', ''), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
}).outputText;
const fixtures = [
    {name: 'hdr-pq-alpha', bytes: avifHdrPqAlpha.toString('base64'), side: 2000},
    {name: 'hdr-hlg-alpha', bytes: avifHdrHlgAlpha.toString('base64'), side: 2000},
    {name: 'hdr-pq-clli', bytes: avifHdrPqClli.toString('base64'), side: 2000},
    {name: 'hdr-pq', bytes: avifHdrPq.toString('base64'), side: 2000},
    {name: 'hdr-hlg', bytes: avifHdrHlg.toString('base64'), side: 2000},
    {name: 'linear10', bytes: avifLinear10.toString('base64'), side: 2000},
    {name: 'linear12', bytes: avifLinear12.toString('base64'), side: 2000},
    {name: 'cicp-bt709', bytes: avifCicpBt709.toString('base64'), side: 2000},
    {name: 'cicp-p3', bytes: avifCicpP3.toString('base64'), side: 2000},
    {name: 'cicp-linear', bytes: avifCicpLinear.toString('base64'), side: 2000},
    {name: 'wide-gamut', bytes: avifWideGamut.toString('base64'), side: 2000},
    {name: 'crop-alpha', bytes: avifGrid.toString('base64'), side: 2000},
    {name: 'animation', bytes: avifAnimation.toString('base64'), side: 2000},
    {name: 'crop-alpha-one-pixel', bytes: avifGrid.toString('base64'), side: 1},
];
const code = `(async () => {
    const unwrap = (value) => { if (value == null) throw Error('Missing canvas'); return value; };
    const debugAssert = (value) => { if (!value) throw Error('Invalid dimensions'); };
    const isSupportedImageType = (type) => ['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(type);
    const isAlphaChannelSupported = (type) => type !== 'image/jpeg' && isSupportedImageType(type);
    ${resize}
    const results = [];
    for (const fixture of ${JSON.stringify(fixtures)}) {
        const file = new Blob([Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0))], {type: 'image/avif'});
        const outputs = [];
        for (const [type, side, quality] of [['image/avif', fixture.side, 0.85], ['image/jpeg', Math.min(fixture.side, 512), 0.8]]) {
            const prepared = await downsizeImage(file, type, side, quality);
            if (!prepared) throw Error('Fixture failed');
            const bitmap = await createImageBitmap(prepared.resized);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0); bitmap.close();
            outputs.push({mimeType: prepared.resized.type, originalDimensions: prepared.originalDimensions,
                dimensions: prepared.resizedDimensions, bytes: prepared.resized.size,
                rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)});
        }
        results.push({name: fixture.name, outputs});
    }
    return results;
})()`;
const temporary = mkdtempSync(join(tmpdir(), 'bridge-renderer-fixtures-'));
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
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.electron, '40.10.0');
    assert.equal(report.chromium, '144.0.7559.236');
    for (const result of report.results) {
        assert.equal(result.outputs[0].mimeType, 'image/png');
        assert.equal(result.outputs[1].mimeType, 'image/jpeg');
    }
    mkdirSync(join(root, '.local'), {recursive: true});
    writeFileSync(
        join(root, '.local/renderer-image-report.json'),
        JSON.stringify(
            {
                sourceSha256: createHash('sha256').update(source).digest('hex'),
                ...report,
            },
            null,
            2,
        ) + '\n',
        {mode: 0o600},
    );
    console.log(
        `Verified ${report.results.length} synthetic fixtures in Electron ${report.electron}; report: .local/renderer-image-report.json`,
    );
} finally {
    rmSync(temporary, {recursive: true, force: true});
}
