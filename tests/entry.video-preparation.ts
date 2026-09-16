import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {prepareOutboundAttachment} from '../src/media/outbound-attachment.ts';
import {prepareVideoAttachment} from '../src/media/video-preparation.ts';
import {inspectVideoSource} from '../src/media/video-inspector.ts';

const reference = JSON.parse(
    await readFile(new URL('./fixtures/video-timelines.json', import.meta.url), 'utf8'),
);
for (const fixture of reference.files)
    await test(`video preparation preserves Desktop metadata and tracks: ${fixture.name}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'video-preparation-'));
        const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
        const plain = Buffer.from(fixture.bytes, 'base64'),
            key = randomBytes(32),
            iv = randomBytes(16);
        assert.equal(createHash('sha256').update(plain).digest('hex'), fixture.sha256);
        try {
            if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
                await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
            const cipher = createCipheriv('aes-256-ctr', key, iv);
            const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
            const source = await prepareOutboundAttachment(Readable.from([encrypted]), directory, {
                bytes: plain.length,
                maxBytes: 1048576,
                mimeType: fixture.mime,
                file: {
                    v: 'v2',
                    key: {
                        kty: 'oct',
                        alg: 'A256CTR',
                        k: key.toString('base64url'),
                        key_ops: ['decrypt'],
                    },
                    iv: iv.toString('base64'),
                    hashes: {sha256: createHash('sha256').update(encrypted).digest('base64')},
                },
                verifyMime: async () => {},
            });
            const codec = {
                limiter,
                avcEncoder:
                    process.env.VIDEO_TEST_AVC_ENCODER === 'libx264'
                        ? ('libx264' as const)
                        : ('libopenh264' as const),
                executable:
                    process.env.FFMPEG_TEST_EXECUTABLE ??
                    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
                cpuSeconds: 10,
                memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
                maximumInputBytes: 1048576,
                maximumOutputBytes: 1048576,
                timeoutMs: 15000,
            };
            const inspection = {
                limiter,
                executable: process.execPath,
                cpuSeconds: 5,
                memoryBytes: Number(
                    process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368,
                ),
                timeoutMs: 10000,
                maximumDurationSeconds: 3,
                maximumReadBytes: 1048576,
            };
            const prepared = await prepareVideoAttachment(source, directory, {codec, inspection});
            try {
                await assert.rejects(source.read(0, 1), /disposed/);
                assert.equal(prepared.metadata.durationSeconds, fixture.durationSeconds);
                assert.equal(prepared.metadata.width, 64);
                assert.equal(prepared.metadata.height, 48);
                assert.equal(prepared.metadata.mimeType, 'video/mp4');
                assert.equal(prepared.metadata.bytes, prepared.attachment.bytes);
                const output = await inspectVideoSource(prepared.attachment, inspection);
                assert(Math.abs(output.durationSeconds - fixture.outputDurationSeconds) < 0.002);
                assert.equal(output.tracks.filter((track) => track.type === 'video').length, 1);
                assert.equal(
                    output.tracks.filter((track) => track.type === 'audio').length,
                    fixture.name === 'avc-aac' ? 1 : 0,
                );
                const outputBytes = await prepared.attachment.read(0, prepared.attachment.bytes);
                const remaining = (await readdir(directory)).filter((name) =>
                    name.startsWith('outbound-attachment-'),
                );
                assert.equal(remaining.length, 1, 'Only the generated ciphertext remains');
                assert.notDeepEqual(
                    await readFile(join(directory, remaining[0]!, 'ciphertext')),
                    outputBytes,
                );
                assert.equal(outputBytes.toString('ascii', 4, 8), 'ftyp');
            } finally {
                await prepared.attachment.dispose();
            }
            assert.deepEqual(
                (await readdir(directory)).filter((name) =>
                    name.startsWith('outbound-attachment-'),
                ),
                [],
            );
        } finally {
            key.fill(0);
            await rm(directory, {recursive: true, force: true});
        }
    });

await test('video preparation cancels both stages and removes provisional outputs on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-preparation-failure-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    const bytes = Buffer.from(reference.files[0].bytes, 'base64');
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const codec = {
            limiter,
            executable:
                process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
            cpuSeconds: 10,
            memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
            maximumInputBytes: 1048576,
            maximumOutputBytes: 1048576,
            timeoutMs: 15000,
        };
        const inspection = {
            limiter,
            executable: process.execPath,
            cpuSeconds: 5,
            memoryBytes: Number(process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ?? 805306368),
            timeoutMs: 10000,
            maximumDurationSeconds: 3,
            maximumReadBytes: 1048576,
        };
        let disposals = 0;
        const source = () => ({
            bytes: bytes.length,
            read: async (start: number, end: number) => Buffer.from(bytes.subarray(start, end)),
            stream: () => Readable.from([bytes]),
            dispose: async () => {
                disposals++;
            },
        });
        await assert.rejects(
            prepareVideoAttachment(source(), directory, {
                codec: {...codec, maximumOutputBytes: 1},
                inspection,
            }),
        );
        assert.equal(disposals, 1);
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
        for (const abortedStage of ['codec', 'inspection'] as const) {
            const abort = new AbortController();
            const original = source();
            let reads = 0;
            const interrupted = {
                ...original,
                read: async (start: number, end: number) => {
                    reads++;
                    abort.abort();
                    return original.read(start, end);
                },
            };
            await assert.rejects(
                prepareVideoAttachment(interrupted, directory, {
                    codec: {...codec, ...(abortedStage === 'codec' ? {signal: abort.signal} : {})},
                    inspection: {
                        ...inspection,
                        ...(abortedStage === 'inspection' ? {signal: abort.signal} : {}),
                    },
                }),
            );
            assert.equal(reads, 1);
        }
        assert.equal(disposals, 3);
        // A valid MP4 index can conceal unusable encoded samples. Preserve every box/index
        // and corrupt only mdat payloads, then substitute this output for the encoder.
        const good = await prepareVideoAttachment(source(), directory, {codec, inspection});
        const damaged = await good.attachment.read(0, good.attachment.bytes);
        await good.attachment.dispose();
        let mediaBoxes = 0;
        for (let offset = 0; offset < damaged.length; ) {
            const size = damaged.readUInt32BE(offset);
            assert(size >= 8 && offset + size <= damaged.length);
            if (damaged.toString('ascii', offset + 4, offset + 8) === 'mdat') {
                damaged.fill(0, offset + 8, offset + size);
                mediaBoxes++;
            }
            offset += size;
        }
        assert(mediaBoxes > 0);
        const inspected = await inspectVideoSource(
            {
                bytes: damaged.length,
                read: async (start, end) => Buffer.from(damaged.subarray(start, end)),
            },
            inspection,
        );
        assert.equal(inspected.tracks[0]!.codec, 'avc', 'Container inspection still succeeds');
        const damagedPath = join(directory, 'damaged.mp4');
        const wrapper = join(directory, 'damaged-encoder');
        await writeFile(damagedPath, damaged);
        const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        await writeFile(
            wrapper,
            '#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = mp4 ]; then\ncat >/dev/null\ncat ' +
                quote(damagedPath) +
                '\nexit 0\nfi\ndone\nexec ' +
                quote(codec.executable) +
                ' "$@"\n',
            {mode: 0o700},
        );
        const before = disposals;
        await assert.rejects(
            prepareVideoAttachment(source(), directory, {
                codec: {...codec, executable: wrapper},
                inspection,
            }),
            'Corrupt encoded samples must not be handed off as a valid video',
        );
        assert.equal(disposals, before + 1);
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
        const {VideoPreparationCleanupError} = await import('../src/media/video-preparation.ts');
        await assert.rejects(
            prepareVideoAttachment(
                {
                    ...source(),
                    dispose: async () => {
                        throw new Error('Cleanup failed');
                    },
                },
                directory,
                {codec: {...codec, maximumInputBytes: 1}, inspection},
            ),
            VideoPreparationCleanupError,
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
