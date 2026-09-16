import {parsePreparedFileSend} from '../threema/prepared-file-send.ts';
import {parsePreparedVideoSend, type PreparedVideoSend} from '../threema/prepared-video-send.ts';

type Metadata = {fileName: string; mediaType: string; bytes: number; caption?: string};
type Thumbnail =
    | {
          thumbnailMediaType: 'image/png' | 'image/jpeg';
          thumbnailBytes: number;
          thumbnailWidth: number;
          thumbnailHeight: number;
      }
    | {
          thumbnailMediaType?: never;
          thumbnailBytes?: never;
          thumbnailWidth?: never;
          thumbnailHeight?: never;
      };
/** Canonical output metadata only; opaque worker tokens are intentionally absent. */
export type VideoProjection = Metadata &
    (
        | ({
              kind: 'video';
              mediaType: 'video/mp4';
              durationSeconds: number;
              width: number;
              height: number;
          } & Thumbnail)
        | {kind: 'file'}
    );
export function parseVideoProjection(value: unknown): VideoProjection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid video projection');
    const row = value as Record<string, unknown>;
    const baseKeys = ['kind', 'fileName', 'mediaType', 'bytes', 'caption'];
    const thumbnailKeys = [
        'thumbnailMediaType',
        'thumbnailBytes',
        'thumbnailWidth',
        'thumbnailHeight',
    ];
    const allowed =
        row.kind === 'video'
            ? [...baseKeys, 'durationSeconds', 'width', 'height', ...thumbnailKeys]
            : baseKeys;
    const count = (value: unknown): number => {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1024 ** 3)
            throw new Error('Invalid video projection byte count');
        return value as number;
    };
    if (
        Object.keys(row).some((key) => !allowed.includes(key)) ||
        (row.kind !== 'video' && row.kind !== 'file')
    )
        throw new Error('Invalid video projection');
    const bytes = count(row.bytes);
    const file = parsePreparedFileSend({
        profile: 'SELF1234',
        chatId: 'c:SELF1234',
        token: '0'.repeat(64),
        fileName: row.fileName,
        mediaType: row.mediaType,
        ...(row.caption === undefined ? {} : {caption: row.caption}),
    });
    const metadata = {
        fileName: file.fileName,
        mediaType: file.mediaType,
        bytes,
        ...(file.caption === undefined ? {} : {caption: file.caption}),
    };
    if (row.kind === 'file') return {...metadata, kind: 'file'};
    const hasThumbnail = thumbnailKeys.some((key) => key in row);
    if (hasThumbnail && !thumbnailKeys.every((key) => key in row))
        throw new Error('Incomplete video projection thumbnail');
    const video: PreparedVideoSend = parsePreparedVideoSend({
        ...file,
        durationSeconds: row.durationSeconds,
        width: row.width,
        height: row.height,
        ...(hasThumbnail
            ? {
                  thumbnailToken: '1'.repeat(64),
                  thumbnailMediaType: row.thumbnailMediaType,
                  thumbnailWidth: row.thumbnailWidth,
                  thumbnailHeight: row.thumbnailHeight,
              }
            : {}),
    });
    const base = {
        ...metadata,
        kind: 'video' as const,
        mediaType: 'video/mp4' as const,
        durationSeconds: video.durationSeconds,
        width: video.width,
        height: video.height,
    };
    if (!hasThumbnail) return base;
    return {
        ...base,
        thumbnailMediaType: video.thumbnailMediaType!,
        thumbnailBytes: count(row.thumbnailBytes),
        thumbnailWidth: video.thumbnailWidth!,
        thumbnailHeight: video.thumbnailHeight!,
    };
}
