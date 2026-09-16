import {inspectVideoSource} from '../src/media/video-inspector.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {
    Input,
    StreamSource,
    ALL_FORMATS,
} from '../.local/sources/threema-desktop/apps/desktop/node_modules/mediabunny/dist/modules/src/index.js';
import {prepareOutboundAttachment} from '../src/media/outbound-attachment.ts';

await test('Desktop parser reads exact video timing and dimensions through verified encrypted ranges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-source-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const reference = JSON.parse(
        await readFile(new URL('./fixtures/video-timelines.json', import.meta.url), 'utf8'),
    );
    assert.equal(reference.mediabunnyVersion, '1.34.4');
    assert.equal(reference.files.length, 4);
    assert.equal(
        JSON.parse(
            await readFile(
                new URL(
                    '../.local/sources/threema-desktop/apps/desktop/node_modules/mediabunny/package.json',
                    import.meta.url,
                ),
                'utf8',
            ),
        ).version,
        reference.mediabunnyVersion,
    );
    try {
        for (const fixture of reference.files) {
            const plain = Buffer.from(fixture.bytes, 'base64');
            assert.equal(createHash('sha256').update(plain).digest('hex'), fixture.sha256);
            const key = randomBytes(32),
                iv = randomBytes(16);
            const cipher = createCipheriv('aes-256-ctr', key, iv);
            const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
            const attachment = await prepareOutboundAttachment(
                Readable.from([ciphertext]),
                directory,
                {
                    bytes: ciphertext.length,
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
                        hashes: {sha256: createHash('sha256').update(ciphertext).digest('base64')},
                    },
                    verifyMime: async () => {},
                },
            );
            let readBytes = 0;
            const source = new StreamSource({
                getSize: () => attachment.bytes,
                maxCacheSize: 1024 * 1024,
                prefetchProfile: 'none',
                read: (start, end) => {
                    let offset = start;
                    return new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            const next = Math.min(end, offset + 65536);
                            const bytes = await attachment.read(offset, next);
                            readBytes += bytes.length;
                            assert(readBytes <= 4 * 1024 * 1024);
                            offset = next;
                            controller.enqueue(bytes);
                            if (offset === end) controller.close();
                        },
                    });
                },
            });
            const input = new Input({formats: ALL_FORMATS, source});
            try {
                assert.equal(await input.computeDuration(), fixture.durationSeconds, fixture.name);
                assert.equal(await input.getFirstTimestamp(), fixture.firstTimestamp, fixture.name);
                const videos = await input.getVideoTracks();
                assert.equal(videos.length, 1);
                assert.equal(videos[0]!.displayWidth, 64);
                assert.equal(videos[0]!.displayHeight, 48);
                assert.equal(
                    (await input.getAudioTracks()).length,
                    fixture.name === 'avc-aac' ? 1 : 0,
                );
                assert(readBytes > 0);
                const isolated = await inspectVideoSource(attachment, {
                    limiter,
                    executable: process.execPath,
                    cpuSeconds: 5,
                    memoryBytes: Number(
                        process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ??
                            process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ??
                            805306368,
                    ),
                    timeoutMs: 10000,
                    maximumDurationSeconds: 3,
                    maximumReadBytes: 4 * 1024 * 1024,
                });
                assert.equal(isolated.durationSeconds, fixture.durationSeconds);
                assert.equal(isolated.firstTimestamp, fixture.firstTimestamp);
                assert.equal(isolated.tracks.filter((track) => track.type === 'video').length, 1);
                assert.equal(
                    isolated.tracks.filter((track) => track.type === 'audio').length,
                    fixture.name === 'avc-aac' ? 1 : 0,
                );
                const spool = (await readdir(directory)).find((name) =>
                    name.startsWith('outbound-attachment-'),
                )!;
                assert.deepEqual(await readFile(join(directory, spool, 'ciphertext')), ciphertext);
            } finally {
                input.dispose();
                await attachment.dispose();
                key.fill(0);
            }
        }
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
