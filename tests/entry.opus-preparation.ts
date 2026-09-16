import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {prepareOpusAttachment} from '../src/media/audio-preparation.ts';

await test('Opus fallback preparation produces bounded MP4 audio and disposes encrypted spools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opus-preparation-'));
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
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
        const references = JSON.parse(
            await readFile(new URL('./fixtures/audio-timelines.json', import.meta.url), 'utf8'),
        );
        const bytes = Buffer.from(
            references.files.find((file: {name: string}) => file.name === 'flac').bytes,
            'base64',
        );
        let disposals = 0;
        const source = () => ({
            bytes: bytes.length,
            stream: () => Readable.from([bytes]),
            dispose: async () => {
                disposals++;
            },
        });
        const prepared = await prepareOpusAttachment(source(), directory, options);
        try {
            assert.equal(disposals, 1);
            assert.equal(prepared.metadata.durationSeconds, 0.25);
            assert.equal(prepared.metadata.mimeType, 'audio/mp4');
            const chunks = [];
            for await (const chunk of prepared.attachment.stream()) chunks.push(Buffer.from(chunk));
            const output = Buffer.concat(chunks);
            assert.equal(output.toString('ascii', 4, 8), 'ftyp');
            const probe = JSON.parse(
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
                    {input: output, timeout: 3000, maxBuffer: 65536},
                ).toString(),
            );
            assert.deepEqual(
                probe.streams.map((stream: {codec_name: string}) => stream.codec_name),
                ['opus'],
            );
            const pcm = execFileSync(
                executable,
                [
                    '-v',
                    'error',
                    '-i',
                    'pipe:0',
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
            assert(pcm.length / 2 >= 12000 && pcm.length / 2 <= 12960);
        } finally {
            await prepared.attachment.dispose();
        }
        await assert.rejects(
            prepareOpusAttachment(source(), directory, {...options, maximumOutputBytes: 1}),
        );
        assert.equal(disposals, 2);
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
