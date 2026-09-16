import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, symlink, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {prepareAudioWithFallback} from '../src/media/audio-fallback.ts';

await test('audio fallback preserves its source through AAC and Opus attempts, then transfers original ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audio-fallback-'));
    const realCodec =
        process.env.FFMPEG_TEST_EXECUTABLE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
    const executable = join(directory, 'ffmpeg'),
        limiter = join(directory, 'launcher');
    const options = {
        limiter,
        executable,
        cpuSeconds: 2,
        memoryBytes: 536870912,
        maximumInputBytes: 1048576,
        maximumOutputBytes: 1048576,
        timeoutMs: 3000,
        maximumDurationSeconds: 2,
    };
    const reference = JSON.parse(
        await readFile(new URL('./fixtures/audio-timelines.json', import.meta.url), 'utf8'),
    );
    const bytes = Buffer.from(
        reference.files.find((file: {name: string}) => file.name === 'flac').bytes,
        'base64',
    );
    const wrapper = async (rejected: string[]) =>
        writeFile(
            executable,
            `#!${process.execPath}\nconst {spawn}=require('node:child_process'); const args=process.argv.slice(2); if(args.some(arg=>${JSON.stringify(rejected)}.includes(arg))) process.exit(1); const child=spawn(${JSON.stringify(realCodec)},args,{stdio:'inherit'}); child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code??1));\n`,
            {mode: 0o700},
        );
    try {
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        await symlink(realCodec.replace(/ffmpeg$/, 'ffprobe'), join(directory, 'ffprobe'));
        for (const [rejected, encoding] of [
            [[], 'aac'],
            [['aac'], 'opus'],
            [['aac', 'libopus'], 'original'],
        ] as const) {
            await wrapper([...rejected]);
            let disposed = 0;
            const source = {
                bytes: bytes.length,
                stream: () => {
                    assert.equal(disposed, 0);
                    return Readable.from([bytes]);
                },
                dispose: async () => {
                    disposed++;
                },
            };
            const result = await prepareAudioWithFallback(source, directory, options, 'audio/flac');
            assert.equal(result.encoding, encoding);
            assert.equal(disposed, encoding === 'original' ? 0 : 1);
            const chunks = [];
            for await (const chunk of result.prepared.attachment.stream())
                chunks.push(Buffer.from(chunk));
            if (encoding === 'original') assert.deepEqual(Buffer.concat(chunks), bytes);
            else assert.equal(Buffer.concat(chunks).toString('ascii', 4, 8), 'ftyp');
            await result.prepared.attachment.dispose();
            assert.equal(disposed, 1);
        }
        await wrapper([]);
        let disposals = 0;
        const brokenCleanup = {
            bytes: bytes.length,
            stream: () => Readable.from([bytes]),
            dispose: async () => {
                if (++disposals === 1) throw new Error('Synthetic cleanup failure');
            },
        };
        await assert.rejects(
            prepareAudioWithFallback(brokenCleanup, directory, options, 'audio/flac'),
        );
        assert.equal(disposals, 2);
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(
            prepareAudioWithFallback(
                {
                    bytes: bytes.length,
                    stream: () => {
                        throw new Error('Must not read');
                    },
                    dispose: async () => {},
                },
                directory,
                {...options, signal: aborted.signal},
                'audio/flac',
            ),
        );
        await assert.rejects(
            prepareAudioWithFallback(
                {
                    bytes: bytes.length,
                    stream: () => Readable.from([bytes]),
                    dispose: async () => {},
                },
                directory,
                {...options, maximumOutputBytes: 1},
                'audio/flac',
            ),
        );
        assert.deepEqual(
            (await readdir(directory)).filter((name) => name.startsWith('outbound-attachment-')),
            [],
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
