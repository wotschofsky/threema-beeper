import type {MediaRequest} from '../src/outbox/media-journal.ts';
import {avifGrid} from './fixtures/avif-grid.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {randomBytes, createCipheriv, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {createImagePreparation} from '../src/media/image-preparation.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
for (const mimeType of ['image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const)
    await test(`encrypted Matrix ${mimeType} becomes canonical worker streams with no retained bridge spools`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'image-preparation-'));
        const executable =
            process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
        const limiter =
            process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'synthetic-launcher');
        const original = getRequestFn();
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const fixture =
            mimeType === 'image/avif'
                ? avifGrid
                : mimeType === 'image/webp'
                  ? Buffer.from(
                        'UklGRoQAAABXRUJQVlA4WAoAAAASAAAACwAABwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAIAAAEAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAQBxD9j/4EIqL/AQBBTk1GKAAAAAQAAAIAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAAB1DAiP4HIqL/AQA=',
                        'base64',
                    )
                  : execFileSync(executable, [
                        '-hide_banner',
                        '-loglevel',
                        'error',
                        '-f',
                        'lavfi',
                        '-i',
                        'testsrc=size=40x20',
                        '-frames:v',
                        mimeType === 'image/gif' ? '2' : '1',
                        '-c:v',
                        mimeType === 'image/gif' ? 'gif' : 'mjpeg',
                        '-f',
                        mimeType === 'image/gif' ? 'gif' : 'image2pipe',
                        'pipe:1',
                    ]);
        const key = randomBytes(32),
            iv = randomBytes(16),
            cipher = createCipheriv('aes-256-ctr', key, iv);
        const encrypted = Buffer.concat([cipher.update(fixture), cipher.final()]);
        const streams: Buffer[] = [],
            retained = new Set<string>();
        let downloads = 0;
        try {
            setRequestFn(async () => {
                downloads++;
                return {
                    statusCode: 200,
                    headers: {'content-length': String(encrypted.length)},
                    body: Readable.from([encrypted]),
                };
            });
            const prepare = createImagePreparation({
                client: {
                    homeserverUrl: 'https://invalid',
                    accessToken: 'synthetic',
                    doesServerSupportVersion: async () => true,
                },
                userId: '@bot:invalid',
                directory,
                maximumBytes: async () => 1024 * 1024,
                verifyMime: async (header) => {
                    if (mimeType === 'image/jpeg') assert.equal(header.readUInt16BE(), 0xffd8);
                    else if (mimeType === 'image/gif')
                        assert.equal(header.toString('ascii', 0, 3), 'GIF');
                    else if (mimeType === 'image/avif')
                        assert.equal(header.toString('ascii', 4, 8), 'ftyp');
                    else assert.equal(header.toString('ascii', 8, 12), 'WEBP');
                },
                codec: {
                    limiter,
                    jpegExecutable:
                        process.env.JPEG_ENCODER_TEST_EXECUTABLE ??
                        fileURLToPath(new URL('../.local/jpeg-encode', import.meta.url)),
                    executable,
                    webpExecutable:
                        process.env.WEBP_FIRST_FRAME_TEST_EXECUTABLE ??
                        fileURLToPath(new URL('../.local/webp-first-frame', import.meta.url)),
                    avifExecutable:
                        process.env.AVIF_FIRST_FRAME_TEST_EXECUTABLE ??
                        fileURLToPath(new URL('../.local/avif-first-frame', import.meta.url)),
                    cpuSeconds: 2,
                    memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                    timeoutMs: 3000,
                    maximumSide: 16,
                    maximumPixels: 4096,
                    thumbnailSide: 8,
                    maximumThumbnailBytes: 4096,
                },
                backend: {
                    prepareFile: async (request, source) => {
                        const chunks: Buffer[] = [];
                        for await (const chunk of source) chunks.push(chunk);
                        const data = Buffer.concat(chunks);
                        assert.equal(data.length, request.bytes);
                        streams.push(data);
                        const token = String(streams.length).repeat(64);
                        retained.add(token);
                        return token;
                    },
                    discardPreparedFile: async ({token}) => retained.delete(token),
                },
            });
            const request: MediaRequest = {
                id: createRequestId(),
                profile: 'SELF1234',
                owner: '@owner:invalid',
                room: '!room:invalid',
                event: '$image',
                transaction: 'transaction',
                media: {
                    kind: 'm.image',
                    chat: 'c:ABCD1234',
                    filename: mimeType === 'image/avif' ? 'Photo.avif' : 'Photo.jpg',
                    caption: 'Caption',
                    mimeType,
                    bytes: fixture.length,
                    file: {
                        v: 'v2',
                        url: 'mxc://invalid/id',
                        key: {
                            kty: 'oct',
                            alg: 'A256CTR',
                            key_ops: ['decrypt'],
                            k: key.toString('base64url'),
                        },
                        iv: iv.toString('base64'),
                        hashes: {sha256: createHash('sha256').update(encrypted).digest('base64')},
                    },
                },
            };
            const result = await prepare(request);
            assert.equal(downloads, 1);
            assert.equal(streams.length, 2);
            assert.equal(
                result.request.fileName,
                mimeType === 'image/avif' ? 'Photo.avif' : 'Photo.jpg',
            );
            assert.equal(result.projection.bytes, streams[0]!.length);
            assert.equal(result.projection.thumbnailBytes, streams[1]!.length);
            assert.equal(
                result.projection.width,
                mimeType === 'image/avif'
                    ? 4
                    : mimeType === 'image/webp'
                      ? 12
                      : mimeType === 'image/gif'
                        ? 40
                        : 16,
            );
            assert.equal(result.projection.thumbnailWidth, mimeType === 'image/avif' ? 4 : 8);
            assert.equal(
                result.request.mediaType,
                mimeType === 'image/avif' ? 'image/png' : mimeType,
            );
            assert.equal(result.request.thumbnailMediaType, 'image/jpeg');
            assert.equal(
                result.projection.mediaType,
                mimeType === 'image/avif' ? 'image/png' : mimeType,
            );
            assert.equal(result.projection.thumbnailMediaType, 'image/jpeg');
            assert.equal(streams[1]!.readUInt16BE(0), 0xffd8);
            if (mimeType === 'image/avif')
                assert.equal(streams[0]!.subarray(1, 4).toString(), 'PNG');
            else if (mimeType !== 'image/jpeg') assert.deepEqual(streams[0], fixture);
            else assert.equal(streams[0]!.readUInt16BE(0), 0xffd8);
            assert.deepEqual(
                await readdir(directory),
                process.env.MEDIA_LIMITER_TEST_EXECUTABLE ? [] : ['synthetic-launcher'],
            );
            await result.discard();
            assert.equal(retained.size, 0);
            if (mimeType === 'image/avif') {
                encrypted[0] = encrypted[0]! ^ 1;
                await assert.rejects(prepare({...request, id: createRequestId()}));
                assert.equal(
                    streams.length,
                    2,
                    'Unauthenticated AVIF bytes must never reach worker staging',
                );
                assert.equal(retained.size, 0);
                assert.deepEqual(
                    await readdir(directory),
                    process.env.MEDIA_LIMITER_TEST_EXECUTABLE ? [] : ['synthetic-launcher'],
                );
            }
        } finally {
            setRequestFn(original);
            key.fill(0);
            await rm(directory, {recursive: true, force: true});
        }
    });
