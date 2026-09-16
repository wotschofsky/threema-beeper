import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {createHash, createCipheriv, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {BackendController} from '../src/threema/backend-controller.ts';
import {createVideoStaging} from '../src/media/video-staging.ts';
import {createVideoPreparation} from '../src/media/video-download.ts';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';

await test(
    'dedicated worker streams main/thumbnail to native storage and waits for persisted IDs',
    {timeout: 60000},
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'video-worker-'));
        const backend = new BackendController(
            {profileDirectory: directory, wasmFile: ''},
            (_entry, options) =>
                new Worker(new URL('./fixtures/video-session-worker.ts', import.meta.url), options),
        );
        const fixture = JSON.parse(
            await readFile(new URL('./fixtures/video-thumbnails.json', import.meta.url), 'utf8'),
        );
        const reference = fixture.files[0];
        const main = Buffer.from(reference.bytes, 'base64');
        const thumbnail = Buffer.from(reference.jpeg, 'base64');
        assert.equal(createHash('sha256').update(main).digest('hex'), reference.sha256);
        assert.equal(createHash('sha256').update(thumbnail).digest('hex'), reference.jpegSha256);
        const attachment = (bytes: Buffer) => ({
            bytes: bytes.length,
            read: async (start: number, end: number) => Buffer.from(bytes.subarray(start, end)),
            stream: () => Readable.from([bytes]),
            dispose: async () => {},
        });
        const stage = createVideoStaging(backend);
        const bundle = () => ({
            encoding: 'avc' as const,
            prepared: {
                attachment: attachment(main),
                metadata: {
                    mimeType: 'video/mp4' as const,
                    bytes: main.length,
                    width: 64,
                    height: 48,
                    durationSeconds: 1,
                },
            },
            thumbnail: {
                attachment: attachment(thumbnail),
                metadata: {
                    mimeType: 'image/jpeg' as const,
                    bytes: thumbnail.length,
                    width: 64,
                    height: 48,
                },
            },
        });
        const destination = {
            id: 'synthetic-video',
            profile: 'SELF1234',
            chatId: 'c:ABCD1234',
            fileName: 'clip.mp4',
        };
        try {
            await backend.ready;
            assert.equal(await backend.identity(), 'SELF1234');
            const prepared = await stage(destination, bundle());
            assert('durationSeconds' in prepared.request);
            let release!: () => void, entered!: () => void;
            const barrier = new Promise<void>((resolve) => {
                release = resolve;
            });
            const allocating = new Promise<void>((resolve) => {
                entered = resolve;
            });
            let allocated: readonly string[] = [];
            const sending = backend.sendPreparedVideo(prepared.request, async (ids) => {
                allocated = ids;
                entered();
                await barrier;
            });
            await allocating;
            await assert.rejects(readFile(join(directory, 'sent.json')), {code: 'ENOENT'});
            release();
            assert.deepEqual(await sending, allocated);
            const report = JSON.parse(await readFile(join(directory, 'sent.json'), 'utf8'));
            assert.equal(report.length, 1);
            assert.deepEqual(report[0], {
                type: 'video',
                duration: 1,
                dimensions: {width: 64, height: 48},
                main: createHash('sha256').update(main).digest('hex'),
                thumbnail: createHash('sha256').update(thumbnail).digest('hex'),
            });
            await assert.rejects(
                backend.sendPreparedVideo(prepared.request, async () => {
                    assert.fail('Token was already transferred');
                }),
            );
            const uncertain = await stage({...destination, id: 'uncertain'}, bundle());
            assert('durationSeconds' in uncertain.request);
            await assert.rejects(
                backend.sendPreparedVideo(uncertain.request, async () => {
                    throw new Error('Synthetic journal failure');
                }),
            );
            await assert.rejects(
                backend.sendPreparedVideo(uncertain.request, async () => {
                    assert.fail('Claimed token must not be reused');
                }),
            );
            assert.equal(
                JSON.parse(await readFile(join(directory, 'sent.json'), 'utf8')).length,
                1,
            );

            // Continue through authenticated download and real conversion into the same worker.
            const originalTransport = getRequestFn(),
                key = randomBytes(32),
                iv = Buffer.alloc(16);
            const cipher = createCipheriv('aes-256-ctr', key, iv);
            const encrypted = Buffer.concat([cipher.update(main), cipher.final()]);
            const limiter =
                process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
            const stagedHashes: string[] = [];
            let downloads = 0;
            try {
                if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
                    await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
                setRequestFn(async () => {
                    downloads++;
                    return {
                        statusCode: 200,
                        headers: {'content-length': String(encrypted.length)},
                        body: Readable.from([encrypted]),
                    };
                });
                const prepare = createVideoPreparation({
                    client: {
                        homeserverUrl: 'https://invalid',
                        accessToken: 'synthetic',
                        doesServerSupportVersion: async () => true,
                    },
                    userId: '@bot:invalid',
                    directory,
                    maximumBytes: async () => 1048576,
                    verifyMime: async (header) => {
                        assert.equal(header.toString('ascii', 4, 8), 'ftyp');
                    },
                    codec: {
                        limiter,
                        executable:
                            process.env.FFMPEG_TEST_EXECUTABLE ??
                            '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
                        cpuSeconds: 10,
                        memoryBytes: Number(
                            process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912,
                        ),
                        timeoutMs: 15000,
                    },
                    inspection: {
                        limiter,
                        executable: process.execPath,
                        cpuSeconds: 5,
                        memoryBytes: Number(
                            process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368,
                        ),
                        timeoutMs: 10000,
                        maximumDurationSeconds: 3,
                        maximumReadBytes: 1048576,
                    },
                    thumbnail: {
                        jpegExecutable: process.env.JPEG_TEST_EXECUTABLE ?? resolve('.local/jpeg-encode'),
                        maximumThumbnailBytes: 1048576,
                    },
                    backend: {
                        prepareFile: async (request, source, signal) => {
                            const hash = createHash('sha256');
                            const inspected = async function* () {
                                for await (const chunk of source) {
                                    hash.update(chunk);
                                    yield chunk;
                                }
                                stagedHashes.push(hash.digest('hex'));
                            };
                            return backend.prepareFile(request, Readable.from(inspected()), signal);
                        },
                        discardPreparedFile: (request) => backend.discardPreparedFile(request),
                    },
                });
                const converted = await prepare({
                    id: 'downloaded-video',
                    profile: 'SELF1234',
                    owner: '@owner:invalid',
                    room: '!room:invalid',
                    event: '$video',
                    transaction: 'video',
                    media: {
                        kind: 'm.video',
                        chat: 'c:ABCD1234',
                        filename: 'clip.mp4',
                        mimeType: 'video/mp4',
                        bytes: main.length,
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
                            hashes: {
                                sha256: createHash('sha256').update(encrypted).digest('base64'),
                            },
                        },
                    },
                });
                assert.equal(downloads, 1);
                assert.equal(converted.projection.kind, 'video');
                assert('durationSeconds' in converted.request);
                assert(converted.request.thumbnailToken);
                const ids = await backend.sendPreparedVideo(converted.request, async (ids) => {
                    assert.equal(ids.length, 1);
                });
                assert.equal(ids.length, 1);
                const sent = JSON.parse(await readFile(join(directory, 'sent.json'), 'utf8'));
                assert.equal(sent.length, 2);
                assert.equal(stagedHashes.length, 2);
                assert.deepEqual([sent[1].main, sent[1].thumbnail], stagedHashes);
                assert.equal(sent[1].duration, converted.request.durationSeconds);
                assert.deepEqual(sent[1].dimensions, {
                    width: converted.request.width,
                    height: converted.request.height,
                });
            } finally {
                setRequestFn(originalTransport);
                key.fill(0);
            }
        } finally {
            await backend.stop();
            await rm(directory, {recursive: true, force: true});
        }
    },
);
