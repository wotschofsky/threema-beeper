import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {prepareAudioAttachment} from '../src/media/audio-preparation.ts';
import {inspectAudioSource} from '../src/media/audio-timeline.ts';

await test('mixed audio tracks copy AAC in either position and validate copied secondary audio before handoff', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audio-mixed-'));
    const executable =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const probe = executable.replace(/ffmpeg$/, 'ffprobe');
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
    const hashes = (bytes: Buffer, index: number) =>
        JSON.parse(
            execFileSync(
                probe,
                [
                    '-v',
                    'error',
                    '-select_streams',
                    `a:${index}`,
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
        const references = JSON.parse(
            await readFile(new URL('./fixtures/audio-timelines.json', import.meta.url), 'utf8'),
        );
        const aac = join(directory, 'source.m4a');
        await writeFile(
            aac,
            Buffer.from(
                references.files.find((file: {name: string}) => file.name === 'aac-fragmented')
                    .bytes,
                'base64',
            ),
        );
        for (const copied of [0, 1]) {
            const filename = join(directory, `mixed-${copied}.mp4`);
            execFileSync(
                executable,
                [
                    '-v',
                    'error',
                    '-i',
                    aac,
                    '-f',
                    'lavfi',
                    '-i',
                    'sine=frequency=880:sample_rate=48000:duration=0.75',
                    '-map',
                    copied === 0 ? '0:a' : '1:a',
                    '-map',
                    copied === 0 ? '1:a' : '0:a',
                    `-c:a:${copied}`,
                    'copy',
                    `-c:a:${1 - copied}`,
                    'flac',
                    '-strict',
                    '-2',
                    filename,
                ],
                {timeout: 3000},
            );
            const bytes = await readFile(filename);
            const inspected = await inspectAudioSource(Readable.from([bytes]), {
                ...options,
                executable: probe,
            });
            assert.equal(inspected.tracks[copied]!.codec, 'aac');
            assert.equal(inspected.tracks[1 - copied]!.codec, 'flac');
            let reads = 0,
                disposals = 0;
            const prepared = await prepareAudioAttachment(
                {
                    bytes: bytes.length,
                    stream: () => {
                        reads++;
                        return Readable.from([bytes]);
                    },
                    dispose: async () => {
                        disposals++;
                    },
                },
                directory,
                options,
            );
            try {
                assert.equal(reads, copied === 0 ? 3 : 4);
                assert.equal(disposals, 1);
                assert.equal(prepared.metadata.durationSeconds, 0.75);
                const chunks = [];
                for await (const chunk of prepared.attachment.stream())
                    chunks.push(Buffer.from(chunk));
                const output = Buffer.concat(chunks);
                const tracks = await inspectAudioSource(Readable.from([output]), {
                    ...options,
                    executable: probe,
                });
                assert.deepEqual(
                    tracks.tracks.map((track) => track.codec),
                    ['aac', 'aac'],
                );
                const original = hashes(bytes, copied);
                assert(
                    original.length > 0 &&
                        original.every((hash: string) => /^SHA256:[0-9a-f]{64}$/.test(hash)),
                );
                assert.deepEqual(hashes(output, copied), original);
                const pcm = execFileSync(
                    executable,
                    [
                        '-v',
                        'error',
                        '-i',
                        'pipe:0',
                        '-map',
                        `0:a:${1 - copied}`,
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
                assert(pcm.length / 2 >= 36000 && pcm.length / 2 <= 38048);
            } finally {
                await prepared.attachment.dispose();
            }
            if (copied === 1) {
                reads = 0;
                disposals = 0;
                await assert.rejects(
                    prepareAudioAttachment(
                        {
                            bytes: bytes.length,
                            stream: () =>
                                ++reads === 3
                                    ? Readable.from(
                                          (async function* () {
                                              yield bytes;
                                              throw new Error(
                                                  'Synthetic secondary validation read failure',
                                              );
                                          })(),
                                      )
                                    : Readable.from([bytes]),
                            dispose: async () => {
                                disposals++;
                            },
                        },
                        directory,
                        options,
                    ),
                );
                assert.equal(reads, 3, 'Failed secondary validation must prevent encoding/handoff');
                assert.equal(disposals, 1);
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
