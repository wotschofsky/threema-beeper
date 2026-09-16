import type {prepareOutboundAttachment} from './outbound-attachment.ts';
import {measureAudioDuration} from './audio-duration.ts';
import {inspectAudioSource} from './audio-timeline.ts';
import {dirname, join} from 'node:path';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';
import {prepareGeneratedAttachment} from './generated-attachment.ts';

/** Cleanup failure is terminal for fallback: another attempt must not hide retained resources. */
export class AudioPreparationCleanupError extends Error {}

/** Own the verified source until duration measurement, AAC encoding and source cleanup finish. */
async function prepareEncodedAudioAttachment(
    source: Pick<
        Awaited<ReturnType<typeof prepareOutboundAttachment>>,
        'stream' | 'bytes' | 'dispose'
    >,
    directory: string,
    options: Omit<CodecProcessOptions, 'args' | 'allowEarlyInputClose'> & {
        maximumDurationSeconds: number;
    },
    target: 'aac' | 'opus',
) {
    type Metadata = {mimeType: 'audio/mp4'; durationSeconds: number; bytes: number};
    let prepared: Awaited<ReturnType<typeof prepareGeneratedAttachment<Metadata>>> | undefined;
    try {
        if (
            !Number.isSafeInteger(source.bytes) ||
            source.bytes < 1 ||
            source.bytes > options.maximumInputBytes
        )
            throw new Error('Invalid audio source size');
        await measureAudioDuration(source.stream(), options);
        options.signal?.throwIfAborted();
        const inspected = await inspectAudioSource(source.stream(), {
            ...options,
            executable: join(dirname(options.executable), 'ffprobe'),
        });
        const {durationSeconds} = inspected;
        const startTimestamp = Math.max(
            0,
            Math.min(...inspected.tracks.map((track) => track.firstTimestamp)),
        );
        const audioTracks = inspected.tracks.filter((track) => track.type === 'audio');
        if (audioTracks.length === 0) throw new Error('No inspected audio tracks');
        // Re-encoding validates other tracks while decoding them. A copied secondary
        // track needs its own bounded decode so packet copying cannot bypass that check.
        for (const [index, track] of audioTracks.entries())
            if (index > 0 && track.codec === target && track.firstTimestamp >= startTimestamp)
                await measureAudioDuration(source.stream(), {...options, audioTrack: index});
        const streamOptions = audioTracks.flatMap((track, index) =>
            track.codec === target && track.firstTimestamp >= startTimestamp
                ? [`-c:a:${index}`, 'copy']
                : [
                      `-c:a:${index}`,
                      target === 'aac' ? 'aac' : 'libopus',
                      `-b:a:${index}`,
                      // Pinned Mediabunny QUALITY_HIGH resolves AAC/Opus to these targets.
                      target === 'aac' ? '192000' : '128000',
                      `-filter:a:${index}`,
                      'asetpts=N/SR/TB',
                  ],
        );
        options.signal?.throwIfAborted();
        prepared = await prepareGeneratedAttachment(
            async (output): Promise<Metadata> => {
                const result = await runCodecProcess(source.stream(), output, {
                    ...options,
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
                        '0:a',
                        '-vn',
                        '-sn',
                        '-dn',
                        '-map_metadata',
                        '-1',
                        '-map_chapters',
                        '-1',
                        ...streamOptions,
                        '-threads',
                        '1',
                        // Fragmented MP4 can be muxed directly into the ciphertext spool.
                        '-movflags',
                        '+frag_keyframe+empty_moov+default_base_moof',
                        '-frag_duration',
                        '1000000',
                        '-f',
                        'mp4',
                        'pipe:1',
                    ],
                });
                if (result.inputBytes !== source.bytes)
                    throw new Error('Audio source size mismatch');
                return {
                    mimeType: 'audio/mp4',
                    durationSeconds,
                    bytes: result.outputBytes,
                };
            },
            directory,
            {
                maximumBytes: options.maximumOutputBytes,
                mimeType: 'audio/mp4',
                signal: options.signal,
                verifyMime: async (prefix) => {
                    if (
                        prefix.length < 12 ||
                        prefix.toString('ascii', 4, 8) !== 'ftyp' ||
                        prefix.readUInt32BE(0) < 16
                    )
                        throw new Error('Invalid encoded audio container');
                },
            },
        );
        options.signal?.throwIfAborted();
        await source.dispose();
        options.signal?.throwIfAborted();
        return prepared;
    } catch {
        const cleanup = await Promise.allSettled([
            prepared?.attachment.dispose(),
            source.dispose(),
        ]);
        if (cleanup.some((result) => result.status === 'rejected'))
            throw new AudioPreparationCleanupError('Audio preparation cleanup failed');
        throw new Error('Audio preparation failed');
    }
}

type PreparationArguments = [
    source: Parameters<typeof prepareEncodedAudioAttachment>[0],
    directory: string,
    options: Parameters<typeof prepareEncodedAudioAttachment>[2],
];

export function prepareAudioAttachment(...args: PreparationArguments) {
    return prepareEncodedAudioAttachment(...args, 'aac');
}

/** Opus/MP4 must be sent as a generic file, matching Desktop's fallback message kind. */
export function prepareOpusAttachment(...args: PreparationArguments) {
    return prepareEncodedAudioAttachment(...args, 'opus');
}
