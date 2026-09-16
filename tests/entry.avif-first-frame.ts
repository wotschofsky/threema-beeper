import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
    avifGrid as fixture,
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
} from './fixtures/avif-grid.ts';
const executable =
    process.env.AVIF_FIRST_FRAME_TEST_EXECUTABLE ??
    fileURLToPath(new URL('../.local/avif-first-frame', import.meta.url));
function decode(bytes: Buffer, prefix = 1048576, pixels = 1000, declared = bytes.length) {
    return spawnSync(executable, [String(prefix), String(pixels), String(declared)], {
        input: bytes,
        timeout: 3000,
        maxBuffer: 4096,
    });
}
await test('AVIF first frame preserves alpha and matches Desktop full-canvas rotation and mirror', () => {
    for (let angle = 0; angle < 4; angle++) {
        for (let mirror = 0; mirror < 2; mirror++) {
            const input = Buffer.from(fixture);
            input[input.indexOf('irot') + 4] = angle;
            input[input.indexOf('imir') + 4] = mirror;
            // Independently transform a coordinate grid to obtain the expected output.
            let rows = Array.from({length: 4}, (_, y) =>
                Array.from({length: 8}, (_, x) => [30 * x, 60 * y, 20 * (x + y), 63 + 20 * x]),
            );
            for (let turn = 0; turn < angle; turn++) {
                const previous = rows;
                rows = Array.from({length: previous[0]!.length}, (_, y) =>
                    previous.map((row) => row[row.length - 1 - y]!),
                );
            }
            if (mirror === 0) rows.reverse();
            else rows.forEach((row) => row.reverse());
            const result = decode(input);
            assert.equal(result.status, 0, result.stderr.toString());
            const header = `P7\nWIDTH ${rows[0]!.length}\nHEIGHT ${rows.length}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
            assert.deepEqual(
                result.stdout,
                Buffer.concat([Buffer.from(header), Buffer.from(rows.flat(2))]),
            );
        }
    }
});
await test('AVIF decoder rejects corrupt input, invalid declarations and resource bounds', () => {
    for (const args of [
        [fixture, 32, 1000],
        [fixture, 1048576, 31],
        [fixture.subarray(0, 40), 1048576, 1000],
        [fixture, 1048576, 1000, 20],
        [Buffer.alloc(100), 1048576, 1000],
    ] as const) {
        const result = decode(args[0], args[1], args[2], args.length === 4 ? args[3] : undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.toString(), 'AVIF first-frame decoding failed\n');
    }
});

await test('AVIF animation emits only the first frame including its alpha', () => {
    const result = decode(avifAnimation);
    assert.equal(result.status, 0, result.stderr.toString());
    const header = 'P7\nWIDTH 4\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n';
    assert.deepEqual(
        result.stdout,
        Buffer.concat([
            Buffer.from(header),
            Buffer.from(Array.from({length: 8}, () => [255, 0, 0, 63]).flat()),
        ]),
    );
});

await test('AVIF first-frame output matches pinned Electron fixture dimensions and alpha', () => {
    const report = JSON.parse(
        readFileSync(new URL('./fixtures/renderer-avif.json', import.meta.url), 'utf8'),
    );
    assert.equal(report.electron, '40.10.0');
    assert.equal(report.chromium, '144.0.7559.236');
    for (const [name, bytes] of [
        ['crop-alpha', fixture],
        ['animation', avifAnimation],
        ['wide-gamut', avifWideGamut],
        ['cicp-p3', avifCicpP3],
        ['cicp-linear', avifCicpLinear],
        ['cicp-bt709', avifCicpBt709],
        ['linear10', avifLinear10],
        ['linear12', avifLinear12],
        ['hdr-pq', avifHdrPq],
        ['hdr-hlg', avifHdrHlg],
        ['hdr-pq-clli', avifHdrPqClli],
        ['hdr-pq-alpha', avifHdrPqAlpha],
        ['hdr-hlg-alpha', avifHdrHlgAlpha],
    ] as const) {
        const reference = report.results.find((entry: {name: string}) => entry.name === name)
            .outputs[0];
        const result = decode(bytes);
        assert.equal(result.status, 0);
        const header = `P7\nWIDTH ${reference.dimensions.width}\nHEIGHT ${reference.dimensions.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
        assert.equal(result.stdout.subarray(0, header.length).toString(), header);
        const pixels = result.stdout.subarray(header.length);
        assert.equal(pixels.length, reference.rgba.length);
        for (let i = 0; i < pixels.length; i++) {
            // Chromium canvas premultiply/unpremultiply quantization differs by up to two
            // RGB levels on this fixture. Alpha and dimensions must agree exactly.
            let tolerance =
                i % 4 === 3 ||
                name === 'animation' ||
                name.startsWith('linear') ||
                name.startsWith('hdr-pq')
                    ? 0
                    : name === 'hdr-hlg'
                      ? 1
                      : name === 'wide-gamut'
                        ? 5
                        : name.startsWith('cicp-')
                          ? 4
                          : 2;
            if (name.endsWith('-alpha')) {
                const alpha = pixels[i - (i % 4) + 3];
                tolerance =
                    i % 4 === 3 || alpha === 0 || alpha === 255
                        ? 0
                        : alpha === 128
                          ? 1
                          : name === 'hdr-pq-alpha'
                            ? 4
                            : 3;
            }
            assert(Math.abs(pixels[i]! - reference.rgba[i]) <= tolerance);
        }
    }
});

await test('AVIF rejects a malformed embedded ICC profile before emitting pixels', () => {
    const invalid = Buffer.from(avifWideGamut);
    const signature = invalid.indexOf('acsp');
    assert(signature >= 0);
    invalid.write('xxxx', signature);
    const result = decode(invalid);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.toString(), 'AVIF first-frame decoding failed\n');
});

await test('AVIF refuses unimplemented CICP transfer functions instead of returning unconverted pixels', () => {
    for (const transfer of [0, 65535]) {
        const bytes = Buffer.from(avifCicpP3);
        const box = bytes.indexOf('nclx');
        assert(box >= 0);
        bytes.writeUInt16BE(transfer, box + 6);
        const result = decode(bytes);
        assert.equal(result.status, 1);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.toString(), 'AVIF first-frame decoding failed\n');
    }
});
