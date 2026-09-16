import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [filename, pattern, origin] of [
    [
        'OPENH264-PINS.json',
        /^openh264-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/u,
        'https://github.com/cisco/openh264/archive/refs/tags/',
    ],
    [
        'OPUS-PINS.json',
        /^opus-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/u,
        'https://downloads.xiph.org/releases/opus/',
    ],
    [
        'JPEG-PINS.json',
        /^libjpeg-turbo-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/u,
        'https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/',
    ],
    [
        'FFMPEG-PINS.json',
        /^ffmpeg-[0-9]+\.[0-9]+\.[0-9]+\.tar\.xz$/u,
        'https://ffmpeg.org/releases/',
    ],
    [
        'WEBP-PINS.json',
        /^libwebp-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/u,
        'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/',
    ],
    [
        'AVIF-PINS.json',
        /^libavif-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/u,
        'https://github.com/AOMediaCodec/libavif/archive/refs/tags/',
    ],
    [
        'DAV1D-PINS.json',
        /^dav1d-[0-9]+\.[0-9]+\.[0-9]+\.tar\.xz$/u,
        'https://downloads.videolan.org/pub/videolan/dav1d/',
    ],
    [
        'LCMS-PINS.json',
        /^lcms2-[0-9]+\.[0-9]+\.tar\.gz$/u,
        'https://github.com/mm2/Little-CMS/archive/refs/tags/',
    ],
] as const) {
    const pin = JSON.parse(readFileSync(join(root, 'docs', filename), 'utf8'));
    assert.match(pin.archive, pattern);
    assert.match(pin.version, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u);
    const suffix =
        filename === 'LCMS-PINS.json'
            ? `lcms${pin.version}.tar.gz`
            : filename === 'AVIF-PINS.json' || filename === 'OPENH264-PINS.json'
              ? `v${pin.version}.tar.gz`
              : filename === 'DAV1D-PINS.json' || filename === 'JPEG-PINS.json'
                ? `${pin.version}/${pin.archive}`
                : pin.archive;
    assert.equal(pin.url, origin + suffix);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
    const directory = join(root, '.local/codec-sources');
    mkdirSync(directory, {recursive: true});
    const destination = join(directory, pin.archive);
    const verify = (filename: string) => {
        const bytes = readFileSync(filename);
        assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            pin.sha256,
            'Codec source differs from the release pin',
        );
    };
    if (existsSync(destination)) {
        verify(destination);
    } else {
        const temporary = mkdtempSync(join(directory, 'download-'));
        try {
            const archive = join(temporary, pin.archive);
            execFileSync(
                'curl',
                [
                    '--fail',
                    '--silent',
                    '--show-error',
                    '--location',
                    '--proto',
                    '=https',
                    '--proto-redir',
                    '=https',
                    '--max-time',
                    '120',
                    '--max-filesize',
                    filename === 'OPENH264-PINS.json' ? '134217728' : '33554432',
                    '--output',
                    archive,
                    pin.url,
                ],
                {stdio: 'inherit', timeout: 125000},
            );
            verify(archive);
            // Atomic publication on this filesystem; an existing download is never replaced.
            linkSync(archive, destination);
        } finally {
            rmSync(temporary, {recursive: true, force: true});
        }
    }
    console.log(`Verified ${pin.archive}`);
}
