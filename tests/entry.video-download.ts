import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, createCipheriv, createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {createVideoPreparation} from '../src/media/video-download.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';

await test('authenticated video shares one download, rejects corruption, and clears failed tokens before retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-download-'));
    const original = getRequestFn(),
        key = randomBytes(32),
        iv = Buffer.alloc(16);
    const fixture = JSON.parse(
        await readFile(new URL('./fixtures/video-timelines.json', import.meta.url), 'utf8'),
    ).files[0];
    const plaintext = Buffer.from(fixture.bytes, 'base64');
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    let downloads = 0,
        stages = 0,
        failCleanup = false,
        badToken = false;
    const retained = new Set<string>();
    const configuration: Parameters<typeof createVideoPreparation>[0] = {
        client: {
            homeserverUrl: 'https://invalid',
            accessToken: 'synthetic',
            doesServerSupportVersion: async () => true,
        },
        userId: '@bot:invalid',
        directory,
        maximumBytes: async () => 1048576,
        verifyMime: async (header, mime) => {
            assert.equal(mime, 'video/mp4');
            assert.equal(header.toString('ascii', 4, 8), 'ftyp');
        },
        codec: {
            limiter,
            executable:
                process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
            cpuSeconds: 10,
            memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
            timeoutMs: 15000,
        },
        inspection: {
            limiter,
            executable: process.execPath,
            cpuSeconds: 5,
            memoryBytes: Number(process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368),
            timeoutMs: 10000,
            maximumDurationSeconds: 3,
            maximumReadBytes: 1048576,
        },
        backend: {
            prepareFile: async (request, source) => {
                const chunks: Buffer[] = [];
                for await (const chunk of source) chunks.push(chunk);
                const bytes = Buffer.concat(chunks);
                assert.equal(bytes.length, request.bytes);
                assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
                stages++;
                const token = badToken ? 'invalid' : 'a'.repeat(64);
                retained.add(token);
                return token;
            },
            discardPreparedFile: async ({token}) => {
                if (failCleanup) throw new Error('Synthetic cleanup failure');
                return retained.delete(token);
            },
        },
    };
    const request: MediaRequest = {
        id: createRequestId(),
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!room:invalid',
        event: '$video',
        transaction: 'video',
        media: {
            kind: 'm.video',
            chat: 'c:ABCD1234',
            filename: 'clip.mp4',
            caption: 'Caption',
            mimeType: 'video/mp4',
            bytes: plaintext.length,
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
                hashes: {sha256: createHash('sha256').update(ciphertext).digest('base64')},
            },
        },
    };
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        setRequestFn(async (url: URL, input: {headers: Record<string, string>}) => {
            assert.equal(
                new URL(url.toString()).pathname,
                '/_matrix/client/v1/media/download/invalid/id',
            );
            assert.deepEqual(input.headers, {Authorization: 'Bearer synthetic'});
            downloads++;
            return {
                statusCode: 200,
                headers: {'content-length': String(ciphertext.length)},
                body: Readable.from([ciphertext]),
            };
        });
        const prepare = createVideoPreparation(configuration);
        const result = await prepare(request);
        assert.equal(downloads, 1);
        assert.equal(stages, 1);
        assert.equal(result.projection.kind, 'video');
        assert.equal(result.projection.caption, 'Caption');
        await result.discard();
        assert.equal(retained.size, 0);
        ciphertext[0] ^= 1;
        await assert.rejects(prepare(request));
        assert.equal(stages, 1, 'Unauthenticated bytes never reach the worker');
        ciphertext[0] ^= 1;
        badToken = true;
        failCleanup = true;
        await assert.rejects(prepare(request));
        const count = downloads;
        await assert.rejects(prepare(request));
        assert.equal(downloads, count, 'Cleanup blocks another download');
        failCleanup = false;
        badToken = false;
        const retry = await prepare(request);
        assert.equal(downloads, count + 1);
        await retry.discard();
        assert.equal(retained.size, 0);
        const fallback = await createVideoPreparation({
            ...configuration,
            codec: {...configuration.codec, executable: join(directory, 'missing')},
        })(request);
        assert.equal(fallback.projection.kind, 'file');
        assert.equal(fallback.request.fileName, 'clip.mp4');
        await fallback.discard();
        const cancelled = new AbortController();
        cancelled.abort();
        const before = downloads;
        await assert.rejects(
            createVideoPreparation({...configuration, signal: cancelled.signal})(request),
        );
        assert.equal(downloads, before);
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
    } finally {
        setRequestFn(original);
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
