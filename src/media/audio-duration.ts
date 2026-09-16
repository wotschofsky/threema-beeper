import {Writable, type Readable} from 'node:stream';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';

/** Decode the first audio track into a counting sink. No PCM is buffered or written to disk. */
export async function measureAudioDuration(
    input: Readable,
    options: Omit<CodecProcessOptions, 'args' | 'maximumOutputBytes' | 'allowEarlyInputClose'> & {
        maximumDurationSeconds: number;
        audioTrack?: number;
    },
): Promise<{durationSeconds: number; decodedSamples: number}> {
    if (
        !Number.isSafeInteger(options.maximumDurationSeconds) ||
        options.maximumDurationSeconds < 1 ||
        options.maximumDurationSeconds > 10000
    )
        throw new Error('Invalid audio duration limit');
    if (
        options.audioTrack !== undefined &&
        (!Number.isSafeInteger(options.audioTrack) ||
            options.audioTrack < 0 ||
            options.audioTrack >= 128)
    )
        throw new Error('Invalid audio track');
    // A fixed mono sample clock makes the decoded byte count independent of source channels,
    // sample rate, container timestamps and untrusted Matrix duration fields.
    const sampleRate = 48000,
        bytesPerSample = 2;
    const sink = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    const result = await runCodecProcess(input, sink, {
        ...options,
        maximumOutputBytes: options.maximumDurationSeconds * sampleRate * bytesPerSample,
        allowEarlyInputClose: false,
        args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-xerror',
            '-max_alloc',
            '134217728',
            '-protocol_whitelist',
            'pipe',
            '-threads',
            '1',
            '-filter_threads',
            '1',
            '-err_detect',
            'explode',
            '-i',
            'pipe:0',
            '-map',
            `0:a:${options.audioTrack ?? 0}`,
            '-vn',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-ac',
            '1',
            '-ar',
            String(sampleRate),
            '-c:a',
            'pcm_s16le',
            '-threads',
            '1',
            '-f',
            's16le',
            'pipe:1',
        ],
    });
    if (result.outputBytes === 0 || result.outputBytes % bytesPerSample !== 0)
        throw new Error('Invalid decoded audio duration');
    const decodedSamples = result.outputBytes / bytesPerSample;
    return {durationSeconds: decodedSamples / sampleRate, decodedSamples};
}
