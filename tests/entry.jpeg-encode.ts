import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

const executable =
    process.env.JPEG_ENCODER_TEST_EXECUTABLE ??
    fileURLToPath(new URL('../.local/jpeg-encode', import.meta.url));
const header = (depth: number) =>
    Buffer.from(
        `P7\nWIDTH 8\nHEIGHT 8\nDEPTH ${depth}\nMAXVAL 255\nTUPLTYPE ${depth === 4 ? 'RGB_ALPHA' : 'RGB'}\nENDHDR\n`,
    );
const rgba = Buffer.from(
    Array.from({length: 64}, (_, i) => [
        i * 3,
        255 - i * 3,
        i * 2,
        [0, 63, 128, 255][i % 4]!,
    ]).flat(),
);
const rgb = Buffer.from(
    Array.from({length: 64}, (_, i) =>
        [0, 1, 2].map((c) => Math.floor((rgba[i * 4 + c]! * rgba[i * 4 + 3]! + 127) / 255)),
    ).flat(),
);
function encode(input: Buffer, quality = '80', pixels = '64') {
    return spawnSync(executable, [quality, pixels], {input, timeout: 3000, maxBuffer: 65536});
}
function markers(jpeg: Buffer) {
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    const found = new Map<number, Buffer>();
    let offset = 2;
    while (offset + 4 <= jpeg.length) {
        assert.equal(jpeg[offset++], 255);
        const marker = jpeg[offset++]!;
        const length = jpeg.readUInt16BE(offset);
        assert(length >= 2 && offset + length <= jpeg.length);
        found.set(marker, jpeg.subarray(offset + 2, offset + length));
        if (marker === 0xda) break;
        offset += length;
    }
    return found;
}
await test('JPEG encoder applies explicit quality, sampling and black alpha compositing', () => {
    for (const quality of ['0', '80', '85', '100']) {
        const result = encode(Buffer.concat([header(4), rgba]), quality);
        assert.equal(result.status, 0, result.stderr.toString());
        const opaque = encode(Buffer.concat([header(3), rgb]), quality);
        assert.equal(opaque.status, 0);
        assert.deepEqual(result.stdout, opaque.stdout);
        const parsed = markers(result.stdout);
        const frame = parsed.get(0xc0)!;
        assert.equal(frame[0], 8);
        assert.equal(frame.readUInt16BE(1), 8);
        assert.equal(frame.readUInt16BE(3), 8);
        assert.equal(frame[7], quality === '100' ? 0x11 : 0x22);
        assert.equal(parsed.has(0xe1), false); // No EXIF metadata.
        assert.equal(parsed.get(0xe2)?.subarray(0, 12).toString(), 'ICC_PROFILE\0');
        assert.equal(result.stdout.readUInt16BE(result.stdout.length - 2), 0xffd9);
    }
    const low = markers(encode(Buffer.concat([header(3), rgb]), '80').stdout).get(0xdb);
    const high = markers(encode(Buffer.concat([header(3), rgb]), '85').stdout).get(0xdb);
    assert.notDeepEqual(low, high);
});

await test('JPEG encoder matches pinned renderer bytes for opaque, alpha and hidden-color fixtures', () => {
    const reference = JSON.parse(
        readFileSync(new URL('./fixtures/renderer-jpeg.json', import.meta.url), 'utf8'),
    ) as {
        electron: string;
        chromium: string;
        fixtures: {name: string; width: number; height: number; rgba: string}[];
        results: {name: string; quality: number; jpeg: string}[];
    };
    assert.equal(reference.electron, '40.10.0');
    assert.equal(reference.chromium, '144.0.7559.236');
    for (const expected of reference.results) {
        const fixture = reference.fixtures.find((f) => f.name === expected.name)!;
        const input = Buffer.concat([
            Buffer.from(
                `P7\nWIDTH ${fixture.width}\nHEIGHT ${fixture.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
            ),
            Buffer.from(fixture.rgba, 'base64'),
        ]);
        const result = encode(input, String(expected.quality), '1000');
        assert.equal(result.status, 0, result.stderr.toString());
        assert.deepEqual(
            result.stdout,
            Buffer.from(expected.jpeg, 'base64'),
            `${expected.name} quality ${expected.quality}`,
        );
    }
});
await test('JPEG encoder rejects malformed frames and limits with fixed diagnostics', () => {
    const valid = Buffer.concat([header(4), rgba]);
    for (const [input, quality, pixels] of [
        [valid, '101', '64'],
        [valid, '-1', '64'],
        [valid, '80', '63'],
        [valid, '80', '0'],
        [valid, '80', '999999999999999999999999'],
        [valid.subarray(0, valid.length - 1), '80', '64'],
        [Buffer.concat([valid, Buffer.from([1])]), '80', '64'],
        [
            Buffer.from(valid.toString('latin1').replace('WIDTH 8', 'WIDTH 8193'), 'latin1'),
            '80',
            '64',
        ],
        [Buffer.from('P7\n' + 'X'.repeat(200)), '80', '64'],
        [
            Buffer.from(valid.toString('latin1').replace('HEIGHT 8', 'WIDTH 8'), 'latin1'),
            '80',
            '64',
        ],
        [Buffer.from(valid.toString('latin1').replace('RGB_ALPHA', 'RGB'), 'latin1'), '80', '64'],
    ] as const) {
        const result = encode(input, quality, pixels);
        assert.equal(result.status, 1);
        assert.equal(result.stderr.toString(), 'JPEG encoding failed\n');
    }
});
