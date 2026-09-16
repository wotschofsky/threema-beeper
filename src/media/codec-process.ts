import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {Transform, Writable, type Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

/** Trusted adapter supplies executable/arguments; media event content must never choose them. */
export interface CodecProcessOptions {
    limiter: string;
    executable: string;
    args: readonly string[];
    cpuSeconds: number;
    memoryBytes: number;
    maximumInputBytes: number;
    maximumOutputBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
    /** First-frame decoders may close stdin; still drain and validate the entire bounded source. */
    allowEarlyInputClose?: boolean;
}

/** Owns both streams through child close. Outputs must remain provisional until this resolves. */
export async function runCodecProcess(
    input: Readable,
    output: Writable,
    options: CodecProcessOptions,
): Promise<{inputBytes: number; outputBytes: number}> {
    const integer = (value: number, min: number, max: number) =>
        Number.isSafeInteger(value) && value >= min && value <= max;
    if (
        !isAbsolute(options.limiter) ||
        !isAbsolute(options.executable) ||
        !Array.isArray(options.args) ||
        options.args.length > 128 ||
        options.args.some(
            (arg) => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192,
        ) ||
        !integer(options.cpuSeconds, 1, 300) ||
        !integer(options.memoryBytes, 16777216, 4294967296) ||
        !integer(options.maximumInputBytes, 0, 1024 ** 3) ||
        !integer(options.maximumOutputBytes, 1, 1024 ** 3) ||
        !integer(options.timeoutMs, 1, 300000)
    )
        throw new Error('Invalid codec configuration');
    if (options.signal?.aborted) {
        input.destroy();
        output.destroy();
        throw new Error('Media codec interrupted');
    }
    const child = spawn(
        options.limiter,
        [
            String(options.cpuSeconds),
            String(options.memoryBytes),
            String(options.maximumOutputBytes),
            options.executable,
            ...options.args,
        ],
        {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
            env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'},
        },
    );
    let failed = false,
        closed = false,
        stderrBytes = 0,
        inputBytes = 0,
        outputBytes = 0;
    const abort = new AbortController();
    const stop = () => {
        failed = true;
        abort.abort();
        if (!closed && child.pid) {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                child.kill('SIGKILL');
            }
        }
    };
    const completion = new Promise<void>((resolve) => {
        child.on('error', stop);
        child.once('close', (code) => {
            closed = true;
            if (code !== 0) stop();
            resolve();
        });
    });
    child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536) stop();
        // Never retain parser diagnostics: they can include message content or filenames.
    });
    child.stderr.on('error', stop);
    const bounded = (maximum: number, count: (bytes: number) => number) =>
        new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                if (count(chunk.length) > maximum)
                    callback(new Error('Codec stream exceeded limit'));
                else callback(null, chunk);
            },
        });
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener('abort', stop, {once: true});
    if (options.signal?.aborted) stop();
    let inputClosed = false;
    const earlyClose = (error: Error | null | undefined) =>
        options.allowEarlyInputClose === true &&
        ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(
            (error as NodeJS.ErrnoException | undefined)?.code ?? '',
        );
    child.stdin.on('error', (error) => {
        if (earlyClose(error)) inputClosed = true;
        else stop();
    });
    const forward = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            if (inputClosed) return callback();
            child.stdin.write(chunk, (error) => {
                if (earlyClose(error)) {
                    inputClosed = true;
                    callback();
                } else callback(error);
            });
        },
        final(callback) {
            if (inputClosed) return callback();
            child.stdin.end(() => callback());
        },
    });
    try {
        const jobs = [
            pipeline(
                input,
                bounded(options.maximumInputBytes, (bytes) => (inputBytes += bytes)),
                forward,
                {signal: abort.signal},
            ),
            pipeline(
                child.stdout,
                bounded(options.maximumOutputBytes, (bytes) => (outputBytes += bytes)),
                output,
                {signal: abort.signal},
            ),
        ].map((job) =>
            job.catch(() => {
                stop();
            }),
        );
        await Promise.all([...jobs, completion]);
        if (failed) throw new Error('Media codec failed or was interrupted');
        return {inputBytes, outputBytes};
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', stop);
        input.destroy();
        child.stdin.destroy();
        // A successful Transform may still have buffered readable data for its consumer.
        if (failed) output.destroy();
    }
}
