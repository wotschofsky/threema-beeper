import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {prepareAudioAttachment} from '../src/media/audio-preparation.ts';
import {inspectAudioTimeline} from '../src/media/audio-timeline.ts';

await test('compatible AAC packets are copied without an additional lossy encode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audio-copy-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        maximumInputBytes: 1048576,
        maximumOutputBytes: 1048576,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const hashes = (bytes: Buffer) =>
        JSON.parse(
            execFileSync(
                executable.replace(/ffmpeg$/, 'ffprobe'),
                [
                    '-v',
                    'error',
                    '-show_entries',
                    'packet=data_hash',
                    '-show_data_hash',
                    'sha256',
                    '-of',
                    'json',
                    '-i',
                    'pipe:0',
                ],
                {input: bytes, timeout: 3000, maxBuffer: 65536},
            ).toString(),
        ).packets.map((packet: {data_hash: string}) => packet.data_hash);
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const reference = JSON.parse(
            await readFile(new URL('./fixtures/audio-timelines.json', import.meta.url), 'utf8'),
        );
        for (const name of ['aac-fragmented', 'aac-offset']) {
            const fixture = reference.files.find((item: {name: string}) => item.name === name);
            const bytes = Buffer.from(fixture.bytes, 'base64');
            const prepared = await prepareAudioAttachment(
                {
                    bytes: bytes.length,
                    stream: () => Readable.from([bytes]),
                    dispose: async () => {},
                },
                directory,
                options,
            );
            try {
                assert.equal(prepared.metadata.durationSeconds, fixture.durationSeconds);
                const chunks = [];
                for await (const chunk of prepared.attachment.stream())
                    chunks.push(Buffer.from(chunk));
                const original = hashes(bytes);
                assert(
                    original.length > 0 &&
                        original.every((hash: string) => /^SHA256:[0-9a-f]{64}$/.test(hash)),
                );
                assert.deepEqual(hashes(Buffer.concat(chunks)), original, name);
            } finally {
                await prepared.attachment.dispose();
            }
        }
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('AAC conversion retains secondary audio and removes source timestamp gaps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audio-tracks-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        maximumInputBytes: 1048576,
        maximumOutputBytes: 1048576,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const reference = JSON.parse(
            await readFile(new URL('./fixtures/audio-timelines.json', import.meta.url), 'utf8'),
        );
        for (const name of ['aac-gap', 'aac-two-tracks']) {
            const fixture = reference.files.find((item: {name: string}) => item.name === name);
            const bytes = Buffer.from(fixture.bytes, 'base64');
            let disposed = false;
            const prepared = await prepareAudioAttachment(
                {
                    bytes: bytes.length,
                    stream: () => Readable.from([bytes]),
                    dispose: async () => {
                        disposed = true;
                    },
                },
                directory,
                options,
            );
            try {
                assert(disposed);
                assert.equal(
                    prepared.metadata.durationSeconds,
                    0.75,
                    'Metadata preserves source timeline',
                );
                const chunks = [];
                for await (const chunk of prepared.attachment.stream())
                    chunks.push(Buffer.from(chunk));
                const output = Buffer.concat(chunks);
                const probe = JSON.parse(
                    execFileSync(
                        executable.replace(/ffmpeg$/, 'ffprobe'),
                        [
                            '-v',
                            'error',
                            '-show_entries',
                            'stream=codec_type,codec_name,sample_rate,channels',
                            '-of',
                            'json',
                            '-i',
                            'pipe:0',
                        ],
                        {input: output, timeout: 3000, maxBuffer: 65536},
                    ).toString(),
                );
                const lengths = name === 'aac-gap' ? [12000] : [12000, 36000];
                assert.equal(probe.streams.length, lengths.length);
                for (const [index, samples] of lengths.entries()) {
                    assert.equal(probe.streams[index].codec_name, 'aac');
                    assert.equal(probe.streams[index].codec_type, 'audio');
                    const pcm = execFileSync(
                        executable,
                        [
                            '-v',
                            'error',
                            '-i',
                            'pipe:0',
                            '-map',
                            `0:a:${index}`,
                            '-ac',
                            '1',
                            '-ar',
                            '48000',
                            '-f',
                            's16le',
                            'pipe:1',
                        ],
                        {input: output, timeout: 3000, maxBuffer: 1048576},
                    );
                    assert(
                        pcm.length / 2 >= samples && pcm.length / 2 <= samples + 2048,
                        'Each original track retains its decoded audio',
                    );
                }
                const timeline = await inspectAudioTimeline(Readable.from([output]), {
                    ...options,
                    executable: executable.replace(/ffmpeg$/, 'ffprobe'),
                });
                if (name === 'aac-gap')
                    assert(
                        timeline >= 0.25 && timeline < 0.3,
                        'Re-encoding removes the half-second gap',
                    );
                else
                    assert(
                        timeline >= 0.75 && timeline < 0.8,
                        'Output includes the longer secondary track',
                    );
            } finally {
                await prepared.attachment.dispose();
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

await test('AAC preparation measures source duration and retains only ciphertext with atomic cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-audio-preparation-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const fixture = execFileSync(executable, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=0.25',
        '-ac',
        '2',
        '-c:a',
        'flac',
        '-metadata',
        'title=private source title',
        '-f',
        'flac',
        'pipe:1',
    ]);
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: Number(process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ?? 536870912),
        maximumInputBytes: 1048576,
        maximumOutputBytes: 65536,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const spoolNames = async () =>
        (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-'));
    let reads = 0,
        disposals = 0;
    const source = () => ({
        bytes: fixture.length,
        stream: () => {
            reads++;
            return Readable.from([fixture]);
        },
        dispose: async () => {
            disposals++;
        },
    });
    try {
        const prepared = await prepareAudioAttachment(source(), directory, options);
        assert.equal(reads, 3);
        assert.equal(disposals, 1);
        assert.equal(prepared.metadata.durationSeconds, 0.25);
        assert.equal(prepared.metadata.mimeType, 'audio/mp4');
        const chunks: Buffer[] = [];
        for await (const chunk of prepared.attachment.stream()) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, prepared.metadata.bytes);
        assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
        assert.equal(bytes.includes(Buffer.from('private source title')), false);
        const probe = JSON.parse(
            execFileSync(
                executable.replace(/ffmpeg$/, 'ffprobe'),
                [
                    '-v',
                    'error',
                    '-show_entries',
                    'stream=codec_name,codec_type,channels,sample_rate',
                    '-of',
                    'json',
                    '-i',
                    'pipe:0',
                ],
                {input: bytes, timeout: 3000, maxBuffer: 65536},
            ).toString(),
        );
        assert.equal(probe.streams.length, 1);
        assert.equal(probe.streams[0].codec_name, 'aac');
        assert.equal(probe.streams[0].codec_type, 'audio');
        assert.equal(probe.streams[0].channels, 2);
        assert.equal(probe.streams[0].sample_rate, '48000');
        const decoded = execFileSync(
            executable,
            [
                '-v',
                'error',
                '-xerror',
                '-i',
                'pipe:0',
                '-map',
                '0:a:0',
                '-c:a',
                'pcm_s16le',
                '-f',
                's16le',
                'pipe:1',
            ],
            {input: bytes, timeout: 3000, maxBuffer: 65536},
        );
        // AAC padding is distinct from the source duration stored in message metadata.
        assert(decoded.length >= 12000 * 4 && decoded.length <= (12000 + 2048) * 4);
        assert(decoded.some((byte) => byte !== 0));
        const spools = await spoolNames();
        assert.equal(spools.length, 1);
        const stored = await readFile(join(directory, spools[0]!, 'ciphertext'));
        assert(!stored.equals(bytes));
        assert(!stored.includes(Buffer.from('private source title')));
        await prepared.attachment.dispose();
        for (const changes of [
            {maximumOutputBytes: 1},
            {maximumDurationSeconds: 0},
            {executable: '/missing/ffmpeg'},
        ]) {
            await assert.rejects(
                prepareAudioAttachment(source(), directory, {...options, ...changes}),
            );
            assert.deepEqual(await spoolNames(), []);
        }
        let cleanupCalls = 0;
        await assert.rejects(
            prepareAudioAttachment(
                {
                    ...source(),
                    dispose: async () => {
                        if (++cleanupCalls === 1) throw new Error('Synthetic cleanup failure');
                    },
                },
                directory,
                options,
            ),
        );
        assert.equal(cleanupCalls, 2);
        assert.deepEqual(await spoolNames(), []);
        for (const failedRead of [2, 3]) {
            let attempts = 0;
            await assert.rejects(
                prepareAudioAttachment(
                    {
                        ...source(),
                        stream: () =>
                            ++attempts < failedRead
                                ? Readable.from([fixture])
                                : Readable.from(
                                      (async function* () {
                                          yield fixture;
                                          throw new Error('Late source failure');
                                      })(),
                                  ),
                    },
                    directory,
                    options,
                ),
            );
            assert.deepEqual(await spoolNames(), []);
        }
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
