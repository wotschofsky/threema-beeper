import {parsePreparedFileSend} from '../threema/prepared-file-send.ts';

/** Immutable native audio output metadata; worker tokens and storage keys are never persisted. */
interface ProjectionMetadata {
    fileName: string;
    bytes: number;
    caption?: string;
}
export type AudioProjection = ProjectionMetadata &
    (
        | {kind: 'audio'; mediaType: 'audio/mp4'; durationSeconds: number}
        | {kind: 'file'; mediaType: string; durationSeconds?: never}
    );
export function parseAudioProjection(value: unknown): AudioProjection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid audio projection');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some(
            (key) =>
                !['kind', 'fileName', 'mediaType', 'bytes', 'durationSeconds', 'caption'].includes(
                    key,
                ),
        ) ||
        (row.kind !== 'audio' && row.kind !== 'file') ||
        !Number.isSafeInteger(row.bytes) ||
        (row.bytes as number) < 1 ||
        (row.bytes as number) > 1024 ** 3 ||
        (row.kind === 'audio'
            ? typeof row.durationSeconds !== 'number'
            : 'durationSeconds' in row) ||
        (row.caption !== undefined &&
            (typeof row.caption !== 'string' || Buffer.byteLength(row.caption) > 65536))
    )
        throw new Error('Invalid audio projection');
    const metadata = parsePreparedFileSend({
        profile: 'SELF1234',
        chatId: 'c:SELF1234',
        token: '0'.repeat(64),
        fileName: row.fileName,
        mediaType: row.mediaType,
        ...(row.kind === 'audio' ? {audioDurationSeconds: row.durationSeconds} : {}),
        ...(row.caption === undefined ? {} : {caption: row.caption}),
    });
    if (row.kind === 'file')
        return {
            kind: 'file',
            fileName: metadata.fileName,
            mediaType: metadata.mediaType,
            bytes: row.bytes as number,
            ...(metadata.caption === undefined ? {} : {caption: metadata.caption}),
        };
    return {
        kind: 'audio',
        fileName: metadata.fileName,
        mediaType: 'audio/mp4',
        bytes: row.bytes as number,
        durationSeconds: metadata.audioDurationSeconds!,
        ...(metadata.caption === undefined ? {} : {caption: metadata.caption}),
    };
}
