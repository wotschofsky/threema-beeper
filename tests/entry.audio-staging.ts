import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {randomBytes, createCipheriv, createHash} from 'node:crypto';
import {mkdtemp, writeFile, symlink, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {createAudioPreparation} from '../src/media/audio-staging.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';

await test('authenticated audio becomes an opaque AAC token and retries cleanup before downloading again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audio-stage-'));
    const original = getRequestFn(),
        key = randomBytes(32),
        iv = Buffer.alloc(16);
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const fixture = execFileSync(executable, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=0.25',
        '-c:a',
        'flac',
        '-f',
        'flac',
        'pipe:1',
    ]);
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    const encrypted = Buffer.concat([cipher.update(fixture), cipher.final()]);
    let downloads = 0,
        stages = 0,
        discardFailures = 0,
        badToken = false,
        originalFallback = false,
        opusFallback = false;
    const retained = new Set<string>();
    try {
        setRequestFn(async () => {
            downloads++;
            return {
                statusCode: 200,
                headers: {'content-length': String(encrypted.length)},
                body: Readable.from([encrypted]),
            };
        });
        const configuration: Parameters<typeof createAudioPreparation>[0] = {
            client: {
                homeserverUrl: 'https://invalid',
                accessToken: 'synthetic',
                doesServerSupportVersion: async () => true,
            },
            userId: '@bot:invalid',
            directory,
            maximumBytes: async () => 1048576,
            verifyMime: async (header, declared) => {
                assert.equal(declared, 'audio/flac');
                assert.equal(header.toString('ascii', 0, 4), 'fLaC');
            },
            codec: {
                limiter,
                executable,
                cpuSeconds: 2,
                memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                timeoutMs: 3000,
                maximumDurationSeconds: 2,
            },
            backend: {
                prepareFile: async (request, source) => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of source) chunks.push(chunk);
                    const bytes = Buffer.concat(chunks);
                    assert.equal(bytes.length, request.bytes);
                    if (originalFallback) assert.deepEqual(bytes, fixture);
                    else assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
                    if (opusFallback) {
                        const metadata = JSON.parse(
                            execFileSync(
                                executable.replace(/ffmpeg$/, 'ffprobe'),
                                [
                                    '-v',
                                    'error',
                                    '-show_entries',
                                    'stream=codec_name',
                                    '-of',
                                    'json',
                                    '-i',
                                    'pipe:0',
                                ],
                                {input: bytes, timeout: 3000, maxBuffer: 65536},
                            ).toString(),
                        );
                        assert.deepEqual(
                            metadata.streams.map(
                                (stream: {codec_name: string}) => stream.codec_name,
                            ),
                            ['opus'],
                        );
                    }
                    stages++;
                    const token = badToken ? 'bad' : 'a'.repeat(64);
                    retained.add(token);
                    return token;
                },
                discardPreparedFile: async ({token}) => {
                    if (discardFailures > 0) {
                        discardFailures--;
                        throw new Error('Synthetic discard failure');
                    }
                    return retained.delete(token);
                },
            },
        };
        const prepare = createAudioPreparation(configuration);
        const request: MediaRequest = {
            id: createRequestId(),
            profile: 'SELF1234',
            owner: '@owner:invalid',
            room: '!room:invalid',
            event: '$audio',
            transaction: 'audio',
            media: {
                kind: 'm.audio',
                chat: 'c:ABCD1234',
                filename: 'voice.flac',
                caption: 'Caption',
                mimeType: 'audio/flac',
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
        assert.equal(stages, 1);
        assert.equal(result.request.audioDurationSeconds, 0.25);
        assert.equal(result.projection.durationSeconds, 0.25);
        assert.equal(result.request.mediaType, 'audio/mp4');
        assert.equal(result.request.fileName, result.projection.fileName);
        assert.match(result.request.fileName, /^threema-[0-9]+\.m4a$/);
        assert.equal(result.projection.caption, 'Caption');
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
        );
        await result.discard();
        assert.equal(retained.size, 0);
        encrypted[0] ^= 1;
        await assert.rejects(prepare({...request, id: createRequestId()}));
        assert.equal(stages, 1);
        encrypted[0] ^= 1;
        badToken = true;
        discardFailures = 2;
        await assert.rejects(prepare(request));
        const priorDownloads = downloads;
        await assert.rejects(prepare(request));
        assert.equal(downloads, priorDownloads, 'Unfinished cleanup must block another download');
        badToken = false;
        const retried = await prepare(request);
        assert.equal(retained.size, 1);
        await retried.discard();
        assert.equal(retained.size, 0);
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
        );
        originalFallback = true;
        const fallback = createAudioPreparation({
            ...configuration,
            codec: {
                ...configuration.codec,
                executable: join(directory, 'missing-codecs', 'ffmpeg'),
            },
        });
        const file = await fallback({...request, id: createRequestId()});
        assert.equal(file.projection.kind, 'file');
        assert.equal(file.request.audioDurationSeconds, undefined);
        assert.equal(file.request.fileName, request.media.filename);
        assert.equal(file.request.mediaType, request.media.mimeType);
        assert.equal(file.projection.bytes, fixture.length);
        await file.discard();
        assert.equal(retained.size, 0);
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
        );
        originalFallback = false;
        opusFallback = true;
        const wrapper = join(directory, 'ffmpeg');
        const quotedExecutable = "'" + executable.replaceAll("'", "'\\''") + "'";
        await writeFile(
            wrapper,
            `#!/bin/sh\nfor argument do\n  case "$argument" in aac) exit 1;; esac\ndone\nexec ${quotedExecutable} "$@"\n`,
            {mode: 0o700},
        );
        await symlink(executable.replace(/ffmpeg$/, 'ffprobe'), join(directory, 'ffprobe'));
        const prepareOpus = createAudioPreparation({
            ...configuration,
            codec: {...configuration.codec, executable: wrapper},
        });
        const beforeOpusDownloads = downloads;
        const opus = await prepareOpus({...request, id: createRequestId()});
        assert.equal(
            downloads,
            beforeOpusDownloads + 1,
            'Fallback reuses the authenticated download',
        );
        assert.equal(opus.projection.kind, 'file');
        assert.equal(opus.request.audioDurationSeconds, undefined);
        assert.equal(opus.request.mediaType, 'audio/mp4');
        assert.match(opus.request.fileName, /^threema-[0-9]+\.m4a$/);
        assert.equal(opus.projection.caption, 'Caption');
        await opus.discard();
        assert.equal(retained.size, 0);
        assert.equal(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'))
                .length,
            0,
        );
    } finally {
        setRequestFn(original);
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
