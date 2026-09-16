import {Writable, type Readable} from 'node:stream';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';

/** Inspect packet timing with bounded output; executable must be a trusted ffprobe binary. */
export async function inspectAudioSource(
    input: Readable,
    options: Omit<CodecProcessOptions, 'args' | 'maximumOutputBytes' | 'allowEarlyInputClose'> & {
        maximumDurationSeconds: number;
    },
): Promise<{
    durationSeconds: number;
    tracks: {index: number; codec?: string; type?: string; firstTimestamp: number}[];
}> {
    if (
        !Number.isSafeInteger(options.maximumDurationSeconds) ||
        options.maximumDurationSeconds < 1 ||
        options.maximumDurationSeconds > 10000
    )
        throw new Error('Invalid audio timeline limit');
    let pending = '',
        packets = 0;
    const tracks = new Map<string, {minimum: bigint; maximum: bigint}>();
    const metadata = new Map<string, {codec?: string; type?: string}>();
    const timeBases = new Map<string, {numerator: bigint; denominator: bigint}>();
    const parse = (line: string) => {
        if (line === '') return;
        const [kind, ...fields] = line.split('|');
        const values = new Map<string, string>();
        for (const field of fields) {
            if (field === '') continue;
            const [key, value, extra] = field.split('=');
            if (
                !key ||
                value === undefined ||
                extra !== undefined ||
                values.has(key) ||
                ![
                    'stream_index',
                    'pts',
                    'duration',
                    'index',
                    'time_base',
                    'codec_name',
                    'codec_type',
                ].includes(key)
            )
                throw new Error('Invalid packet timeline');
            values.set(key, value);
        }
        const index = values.get(kind === 'packet' ? 'stream_index' : 'index') ?? '';
        if (!/^\d{1,6}$/.test(index)) throw new Error('Invalid timeline track');
        if (kind === 'stream') {
            const rational = /^(\d{1,10})\/(\d{1,10})$/.exec(values.get('time_base') ?? '');
            if (!rational || timeBases.has(index) || timeBases.size >= 128)
                throw new Error('Invalid timeline time base');
            const numerator = BigInt(rational[1]!),
                denominator = BigInt(rational[2]!);
            if (numerator === 0n || denominator === 0n) throw new Error('Invalid time base');
            const codec = values.get('codec_name'),
                type = values.get('codec_type');
            if (
                (codec !== undefined && !/^[a-z0-9_]{1,64}$/.test(codec)) ||
                (type !== undefined &&
                    !['audio', 'video', 'subtitle', 'data', 'attachment', 'unknown'].includes(type))
            )
                throw new Error('Invalid timeline stream metadata');
            metadata.set(index, {codec, type});
            timeBases.set(index, {numerator, denominator});
        } else if (kind === 'packet') {
            const timestamp = values.get('pts') ?? '',
                duration = values.get('duration') ?? '';
            if (!/^-?\d{1,19}$/.test(timestamp) || !/^\d{1,19}$/.test(duration))
                throw new Error('Missing packet timing');
            const start = BigInt(timestamp),
                end = start + BigInt(duration);
            const track = tracks.get(index);
            if (track) {
                if (start < track.minimum) track.minimum = start;
                if (end > track.maximum) track.maximum = end;
            } else {
                if (tracks.size >= 128) throw new Error('Too many timeline tracks');
                tracks.set(index, {minimum: start, maximum: end});
            }
            packets++;
        } else throw new Error('Invalid timeline record');
    };
    const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            try {
                pending += chunk.toString('ascii');
                let newline: number;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    if (newline > 512) throw new Error('Packet timeline line exceeds limit');
                    parse(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);
                }
                if (pending.length > 512) throw new Error('Packet timeline line exceeds limit');
                callback();
            } catch {
                callback(new Error('Invalid audio timeline'));
            }
        },
        final(callback) {
            try {
                parse(pending);
                callback();
            } catch {
                callback(new Error('Invalid audio timeline'));
            }
        },
    });
    await runCodecProcess(input, output, {
        ...options,
        maximumOutputBytes: 64 * 1024 * 1024,
        allowEarlyInputClose: false,
        args: [
            '-v',
            'error',
            '-max_alloc',
            '134217728',
            '-protocol_whitelist',
            'pipe',
            '-threads',
            '1',
            '-show_entries',
            'packet=stream_index,pts,duration:stream=index,time_base,codec_name,codec_type:packet_side_data=',
            '-of',
            'compact=p=1:nk=0',
            '-i',
            'pipe:0',
        ],
    });
    let maximumEnd = 0;
    for (const [index, track] of tracks) {
        const base = timeBases.get(index);
        if (!base) throw new Error('Missing timeline time base');
        const limit = BigInt(options.maximumDurationSeconds) * base.denominator;
        if (track.maximum * base.numerator > limit || track.minimum * base.numerator < -limit)
            throw new Error('Audio timeline exceeds limit');
        maximumEnd = Math.max(
            maximumEnd,
            Number(track.maximum * base.numerator) / Number(base.denominator),
        );
    }
    if (packets === 0 || maximumEnd <= 0) throw new Error('Empty audio timeline');
    return {
        durationSeconds: maximumEnd,
        tracks: [...tracks]
            .map(([index, track]) => {
                const base = timeBases.get(index)!;
                return {
                    index: Number(index),
                    ...metadata.get(index),
                    firstTimestamp:
                        Number(track.minimum * base.numerator) / Number(base.denominator),
                };
            })
            .sort((left, right) => left.index - right.index),
    };
}

export async function inspectAudioTimeline(
    input: Readable,
    options: Parameters<typeof inspectAudioSource>[1],
): Promise<number> {
    return (await inspectAudioSource(input, options)).durationSeconds;
}
