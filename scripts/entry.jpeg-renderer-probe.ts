import assert from 'node:assert/strict';
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
const fixtures = ['opaque', 'alpha', 'hidden-color'].map((name) => ({
    name,
    width: 17,
    height: 13,
    rgba: Array.from({length: 17 * 13}, (_, index) => {
        const x = index % 17,
            y = Math.floor(index / 17);
        return [
            (x * 71 + y * 13) % 256,
            (x * 17 + y * 91) % 256,
            (x * 47 + y * 29) % 256,
            name === 'opaque'
                ? 255
                : name === 'alpha'
                  ? [0, 63, 128, 255][x % 4]!
                  : x < 8
                    ? 0
                    : 255,
        ];
    }).flat(),
}));
const code = `(async () => {
    const results = [];
    for (const fixture of ${JSON.stringify(fixtures)}) {
        const canvas = new OffscreenCanvas(fixture.width, fixture.height);
        const context = canvas.getContext('2d');
        context.putImageData(new ImageData(new Uint8ClampedArray(fixture.rgba), fixture.width, fixture.height), 0, 0);
        for (const quality of [80, 85, 100]) {
            const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: quality / 100});
            results.push({name: fixture.name, quality, jpeg: Array.from(new Uint8Array(await blob.arrayBuffer()))});
        }
    }
    return results;
})()`;
const temporary = mkdtempSync(join(tmpdir(), 'bridge-jpeg-fixtures-'));
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
        results: {name: string; quality: number; jpeg: number[]}[];
    };
    assert.equal(report.electron, '40.10.0');
    assert.equal(report.chromium, '144.0.7559.236');
    const comparisons = report.results.map((result) => {
        const fixture = fixtures.find((f) => f.name === result.name)!;
        const pam = Buffer.concat([
            Buffer.from(
                `P7\nWIDTH ${fixture.width}\nHEIGHT ${fixture.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
            ),
            Buffer.from(fixture.rgba),
        ]);
        const jpeg = execFileSync(
            join(root, '.local/jpeg-encode'),
            [String(result.quality), '1000'],
            {input: pam, timeout: 3000, maxBuffer: 65536},
        );
        return {
            name: result.name,
            quality: result.quality,
            nativeBytes: jpeg.length,
            rendererBytes: result.jpeg.length,
            byteExact: jpeg.equals(Buffer.from(result.jpeg)),
        };
    });
    writeFileSync(
        join(root, '.local/renderer-jpeg-report.json'),
        JSON.stringify({...report, fixtures, comparisons}, null, 2) + '\n',
        {mode: 0o600},
    );
    console.log(JSON.stringify(comparisons, null, 2));
    assert(comparisons.every(result => result.byteExact), 'Native JPEG differs from pinned renderer; inspect report');
} finally {
    rmSync(temporary, {recursive: true, force: true});
}
