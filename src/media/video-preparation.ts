import {Writable} from 'node:stream';
import type {prepareOutboundAttachment} from './outbound-attachment.ts';
import {prepareGeneratedAttachment} from './generated-attachment.ts';
import {inspectVideoSource} from './video-inspector.ts';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';

export class VideoPreparationCleanupError extends Error {}

type Source = Awaited<ReturnType<typeof prepareOutboundAttachment>>;
type Metadata = {
    mimeType: 'video/mp4';
    bytes: number;
    durationSeconds: number;
    width: number;
    height: number;
};
/** Own verified source through full decode, encoding, output validation and cleanup. */
export async function prepareVideoAttachment(
    source: Source,
    directory: string,
    options: {
        codec: Omit<CodecProcessOptions, 'args' | 'allowEarlyInputClose'> & {
            avcEncoder?: 'libopenh264' | 'libx264';
        };
        inspection: Parameters<typeof inspectVideoSource>[1];
    },
) {
    let prepared: Awaited<ReturnType<typeof prepareGeneratedAttachment<Metadata>>> | undefined;
    const codec = {...options.codec},
        inspection = {...options.inspection};
    const signals = [codec.signal, inspection.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.length) codec.signal = inspection.signal = AbortSignal.any(signals);
    try {
        if (
            codec.avcEncoder !== undefined &&
            !['libopenh264', 'libx264'].includes(codec.avcEncoder)
        )
            throw new Error('Unsupported AVC encoder');
        if (
            !Number.isSafeInteger(source.bytes) ||
            source.bytes < 1 ||
            source.bytes > codec.maximumInputBytes
        )
            throw new Error('Invalid video source size');
        codec.signal?.throwIfAborted();
        const input = await inspectVideoSource(source, inspection);
        const videos = input.tracks.filter((track) => track.type === 'video');
        const audios = input.tracks.filter((track) => track.type === 'audio');
        const primary = videos[0]!;
        const common = [
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
        ];
        const validateDecode = async (
            attachment: Source,
            maximumInputBytes: number,
            tracks: number,
        ) => {
            const deadline = performance.now() + codec.timeoutMs;
            // FFmpeg allocates separate thread stacks for each concurrently decoded stream.
            // Validate every track sequentially within one shared wall-clock deadline.
            for (let track = 0; track < tracks; track++) {
                const remaining = Math.floor(deadline - performance.now());
                if (remaining < 1) throw new Error('Video decode deadline exceeded');
                const validated = await runCodecProcess(
                    attachment.stream(),
                    new Writable({
                        write(_chunk, _encoding, callback) {
                            callback();
                        },
                    }),
                    {
                        ...codec,
                        maximumInputBytes,
                        timeoutMs: remaining,
                        allowEarlyInputClose: false,
                        maximumOutputBytes: 1,
                        args: [
                            ...common,
                            '-noautorotate',
                            '-i',
                            'pipe:0',
                            '-map',
                            `0:${track}`,
                            '-c:v',
                            'rawvideo',
                            '-c:a',
                            'pcm_s16le',
                            '-threads',
                            '1',
                            '-f',
                            'null',
                            'pipe:1',
                        ],
                    },
                );
                if (validated.inputBytes !== attachment.bytes)
                    throw new Error('Video decode size mismatch');
            }
        };
        // Packet copy must not bypass validation of malformed media in any AV track.
        await validateDecode(source, codec.maximumInputBytes, input.tracks.length);
        codec.signal?.throwIfAborted();
        const streamOptions = [
            ...videos.flatMap((track, index) =>
                track.codec === 'avc'
                    ? [`-c:v:${index}`, 'copy']
                    : [
                          `-c:v:${index}`,
                          codec.avcEncoder ?? 'libopenh264',
                          `-pix_fmt:v:${index}`,
                          'yuv420p',
                          `-fps_mode:v:${index}`,
                          'passthrough',
                          // Pinned Mediabunny QUALITY_HIGH._toVideoBitrate('avc', width, height).
                          `-b:v:${index}`,
                          String(
                              Math.ceil(
                                  (6000000 *
                                      Math.pow(
                                          (track.codedWidth * track.codedHeight) / (1920 * 1080),
                                          0.95,
                                      )) /
                                      1000,
                              ) * 1000,
                          ),
                      ],
            ),
            ...audios.flatMap((track, index) =>
                track.codec === 'aac'
                    ? [`-c:a:${index}`, 'copy']
                    : [`-c:a:${index}`, 'aac', `-b:a:${index}`, '192000'],
            ),
        ];
        // Negative composition offsets normalize the video-only B-frame case. With
        // a track starting earlier, preserve its relative delay and verify below.
        const negativeOffsets = videos.every(
            (track) => track.firstTimestamp === input.firstTimestamp,
        );
        prepared = await prepareGeneratedAttachment(
            async (output): Promise<Metadata> => {
                const result = await runCodecProcess(source.stream(), output, {
                    ...codec,
                    allowEarlyInputClose: false,
                    args: [
                        ...common,
                        '-copyts',
                        '-noautorotate',
                        '-itsoffset',
                        String(-input.firstTimestamp),
                        '-i',
                        'pipe:0',
                        '-map',
                        '0:v',
                        '-map',
                        '0:a?',
                        '-map_metadata',
                        '-1',
                        '-map_chapters',
                        '-1',
                        ...streamOptions,
                        '-threads',
                        '1',
                        '-avoid_negative_ts',
                        'disabled',
                        '-movflags',
                        '+frag_keyframe+empty_moov+default_base_moof' +
                            (negativeOffsets ? '+negative_cts_offsets' : ''),
                        '-frag_duration',
                        '1000000',
                        '-f',
                        'mp4',
                        'pipe:1',
                    ],
                });
                if (result.inputBytes !== source.bytes)
                    throw new Error('Video source size mismatch');
                return {
                    mimeType: 'video/mp4',
                    bytes: result.outputBytes,
                    durationSeconds: input.durationSeconds,
                    width: primary.width,
                    height: primary.height,
                };
            },
            directory,
            {
                maximumBytes: codec.maximumOutputBytes,
                mimeType: 'video/mp4',
                signal: codec.signal,
                verifyMime: async (prefix) => {
                    if (
                        prefix.length < 12 ||
                        prefix.toString('ascii', 4, 8) !== 'ftyp' ||
                        prefix.readUInt32BE(0) < 16
                    )
                        throw new Error('Invalid video output container');
                },
            },
        );
        const output = await inspectVideoSource(prepared.attachment, inspection);
        const expected = [...videos, ...audios];
        if (output.tracks.length !== expected.length)
            throw new Error('Video conversion discarded tracks');
        for (const [index, track] of output.tracks.entries()) {
            const original = expected[index]!;
            if (
                track.type !== original.type ||
                track.codec !== (track.type === 'video' ? 'avc' : 'aac') ||
                Math.abs(track.firstTimestamp - (original.firstTimestamp - input.firstTimestamp)) >
                    0.001
            )
                throw new Error('Video conversion changed track timing or codec');
            if (
                track.type === 'video' &&
                original.type === 'video' &&
                (track.width !== original.width ||
                    track.height !== original.height ||
                    track.rotation !== original.rotation)
            )
                throw new Error('Video conversion changed display geometry');
            if (
                track.type === 'audio' &&
                original.type === 'audio' &&
                (track.sampleRate !== original.sampleRate || track.channels !== original.channels)
            )
                throw new Error('Video conversion changed audio properties');
        }
        codec.signal?.throwIfAborted();
        // Valid container metadata does not establish that encoded samples decode.
        await validateDecode(prepared.attachment, codec.maximumOutputBytes, output.tracks.length);
        codec.signal?.throwIfAborted();
        await source.dispose();
        codec.signal?.throwIfAborted();
        return prepared;
    } catch {
        const cleanup = await Promise.allSettled([
            prepared?.attachment.dispose(),
            source.dispose(),
        ]);
        if (cleanup.some((result) => result.status === 'rejected'))
            throw new VideoPreparationCleanupError('Video preparation cleanup failed');
        throw new Error('Video preparation failed');
    }
}
