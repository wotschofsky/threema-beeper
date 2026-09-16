import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable, Writable, PassThrough} from 'node:stream';
import {runCodecProcess} from '../src/media/codec-process.ts';

await test(
    'codec runner streams with bounded output and terminates failed or cancelled processes',
    {timeout: 10000},
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codec-process-'));
        const limiter = join(directory, 'synthetic-launcher');
        // Only process orchestration is tested here; native hard limits have separate Linux tests.
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const options = {
            limiter,
            executable: process.execPath,
            args: [] as string[],
            cpuSeconds: 1,
            memoryBytes: 268435456,
            maximumInputBytes: 4096,
            maximumOutputBytes: 4096,
            timeoutMs: 2000,
        };
        const run = (
            code: string,
            bytes = Buffer.from('fixture'),
            changes: Partial<typeof options> & {
                signal?: AbortSignal;
                allowEarlyInputClose?: boolean;
            } = {},
        ) => {
            const chunks: Buffer[] = [];
            const input = Readable.from([bytes]);
            const output = new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
            });
            const result = runCodecProcess(input, output, {
                ...options,
                args: ['-e', code],
                ...changes,
            });
            return {result, input, output, chunks};
        };
        try {
            const prefixReader = 'process.stdin.once("data", () => process.exit(0))';
            const largeInput = Buffer.alloc(4 * 1024 * 1024);
            await assert.rejects(
                run(prefixReader, largeInput, {
                    maximumInputBytes: largeInput.length,
                }).result,
            );
            const early = run(prefixReader, largeInput, {
                maximumInputBytes: largeInput.length,
                allowEarlyInputClose: true,
            });
            assert.equal((await early.result).inputBytes, largeInput.length);
            let drained = false;
            const tail = async function* (fail: boolean) {
                for (let index = 0; index < 4; index++) yield Buffer.alloc(1024 * 1024);
                if (fail) throw new Error('synthetic late source failure');
                drained = true;
            };
            const drain = (fail: boolean) =>
                runCodecProcess(
                    Readable.from(tail(fail)),
                    new Writable({
                        write(_chunk, _encoding, done) {
                            done();
                        },
                    }),
                    {
                        ...options,
                        args: ['-e', prefixReader],
                        maximumInputBytes: largeInput.length,
                        allowEarlyInputClose: true,
                    },
                );
            assert.equal((await drain(false)).inputBytes, largeInput.length);
            assert(drained, 'All source chunks are consumed after the child stops reading');
            await assert.rejects(drain(true));
            await assert.rejects(
                run(prefixReader, largeInput, {
                    maximumInputBytes: largeInput.length - 1,
                    allowEarlyInputClose: true,
                }).result,
            );
            await assert.rejects(
                run('process.stdin.once("data", () => process.exit(2))', largeInput, {
                    maximumInputBytes: largeInput.length,
                    allowEarlyInputClose: true,
                }).result,
            );
            const success = run('process.stdin.pipe(process.stdout)');
            assert.deepEqual(await success.result, {inputBytes: 7, outputBytes: 7});
            assert.equal(Buffer.concat(success.chunks).toString(), 'fixture');
            const buffered = new PassThrough({highWaterMark: 8192});
            await runCodecProcess(Readable.from([Buffer.alloc(4096, 7)]), buffered, {
                ...options,
                args: ['-e', 'process.stdin.pipe(process.stdout)'],
            });
            const retained: Buffer[] = [];
            for await (const chunk of buffered) retained.push(chunk);
            assert.deepEqual(
                Buffer.concat(retained),
                Buffer.alloc(4096, 7),
                'Successful transform output remains readable after child completion',
            );
            for (const scenario of [
                () =>
                    run('process.stdin.pipe(process.stdout)', Buffer.alloc(100), {
                        maximumInputBytes: 10,
                    }),
                () =>
                    run(
                        'process.stdin.resume(); process.stdout.write(Buffer.alloc(100));',
                        undefined,
                        {
                            maximumOutputBytes: 10,
                        },
                    ),
                () =>
                    run(
                        'process.stderr.write("private media".repeat(10000)); setInterval(()=>{},1000)',
                    ),
                () => run('setInterval(()=>{},1000)', undefined, {timeoutMs: 100}),
                () => run('process.exit(2)'),
                () => run('', undefined, {limiter: join(directory, 'missing')}),
            ]) {
                const failure = scenario();
                await assert.rejects(failure.result, /Media codec failed or was interrupted/);
                assert(failure.input.destroyed);
                assert(failure.output.destroyed);
            }
            const abort = new AbortController();
            const cancelled = run('setInterval(()=>{},1000)', undefined, {signal: abort.signal});
            abort.abort();
            await assert.rejects(cancelled.result);
            const preCancelled = run('throw new Error("must not run")', undefined, {
                signal: abort.signal,
            });
            await assert.rejects(preCancelled.result, /interrupted/);
            assert(preCancelled.input.destroyed);
            assert(preCancelled.output.destroyed);
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    },
);
