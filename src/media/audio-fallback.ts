import {
    AudioPreparationCleanupError,
    prepareAudioAttachment,
    prepareOpusAttachment,
} from './audio-preparation.ts';

type Source = Parameters<typeof prepareAudioAttachment>[0];
type Options = Parameters<typeof prepareAudioAttachment>[2];
type Encoded = Awaited<ReturnType<typeof prepareAudioAttachment>>;
export type PreparedAudioFallback =
    | {encoding: 'aac' | 'opus'; prepared: Encoded}
    | {
          encoding: 'original';
          prepared: {attachment: Source; metadata: {mimeType: string; bytes: number}};
      };

/** Own an already authenticated source; preserve it until conversion succeeds or original-file handoff. */
export async function prepareAudioWithFallback(
    source: Source,
    directory: string,
    options: Options,
    sourceMimeType: string,
): Promise<PreparedAudioFallback> {
    let encoded: Encoded | undefined;
    try {
        if (
            ![options.maximumInputBytes, options.maximumOutputBytes].every(
                (limit) => Number.isSafeInteger(limit) && limit >= 1 && limit <= 1024 ** 3,
            ) ||
            !/^audio\/[a-zA-Z0-9!#$&^_.+-]+$/.test(sourceMimeType) ||
            !Number.isSafeInteger(source.bytes) ||
            source.bytes < 1 ||
            source.bytes > options.maximumInputBytes
        )
            throw new Error('Invalid audio fallback source');
        // Each codec owns its generated spool, but cannot dispose the shared source.
        const borrowed: Source = {
            bytes: source.bytes,
            stream: () => source.stream(),
            dispose: async () => {},
        };
        for (const [encoding, prepare] of [
            ['aac', prepareAudioAttachment],
            ['opus', prepareOpusAttachment],
        ] as const) {
            options.signal?.throwIfAborted();
            try {
                encoded = await prepare(borrowed, directory, options);
            } catch (error) {
                options.signal?.throwIfAborted();
                if (error instanceof AudioPreparationCleanupError) throw error;
                continue;
            }
            options.signal?.throwIfAborted();
            await source.dispose();
            options.signal?.throwIfAborted();
            return {encoding, prepared: encoded};
        }
        options.signal?.throwIfAborted();
        if (source.bytes > options.maximumOutputBytes)
            throw new Error('Original audio file exceeds output limit');
        // Caller now owns disposal, just as for a generated attachment.
        return {
            encoding: 'original',
            prepared: {
                attachment: source,
                metadata: {mimeType: sourceMimeType, bytes: source.bytes},
            },
        };
    } catch {
        const cleaned = await Promise.allSettled([encoded?.attachment.dispose(), source.dispose()]);
        if (cleaned.some((result) => result.status === 'rejected'))
            throw new AudioPreparationCleanupError('Audio fallback cleanup failed');
        throw new Error('Audio fallback failed');
    }
}
