import {parsePreparedFileSend, type PreparedFileSend} from './prepared-file-send.ts';
import {parsePreparedToken} from './prepare-file-command.ts';

type VideoThumbnail =
    | {
          thumbnailToken: string;
          thumbnailMediaType: 'image/jpeg' | 'image/png';
          thumbnailWidth: number;
          thumbnailHeight: number;
      }
    | {
          thumbnailToken?: never;
          thumbnailMediaType?: never;
          thumbnailWidth?: never;
          thumbnailHeight?: never;
      };

export type PreparedVideoSend = Omit<PreparedFileSend, 'mediaType' | 'audioDurationSeconds'> & {
    mediaType: 'video/mp4';
    durationSeconds: number;
    width: number;
    height: number;
} & VideoThumbnail;

/** Trusted preparation supplies metadata; storage handles and keys never cross this boundary. */
export function parsePreparedVideoSend(value: unknown): PreparedVideoSend {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid prepared video');
    const row = value as Record<string, unknown>;
    const thumbnailKeys = [
        'thumbnailToken',
        'thumbnailMediaType',
        'thumbnailWidth',
        'thumbnailHeight',
    ];
    const allowed = [
        'profile',
        'chatId',
        'token',
        'fileName',
        'mediaType',
        'caption',
        'durationSeconds',
        'width',
        'height',
        ...thumbnailKeys,
    ];
    if (Object.keys(row).some((key) => !allowed.includes(key)))
        throw new Error('Invalid prepared video');
    const file = parsePreparedFileSend({
        profile: row.profile,
        chatId: row.chatId,
        token: row.token,
        fileName: row.fileName,
        mediaType: row.mediaType,
        ...(row.caption === undefined ? {} : {caption: row.caption}),
    });
    const dimension = (value: unknown, maximum: number): number => {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
            throw new Error('Invalid prepared video dimensions');
        return value as number;
    };
    if (
        file.mediaType !== 'video/mp4' ||
        typeof row.durationSeconds !== 'number' ||
        !Number.isFinite(row.durationSeconds) ||
        row.durationSeconds <= 0 ||
        row.durationSeconds > 10000
    )
        throw new Error('Invalid prepared video format or duration');
    const base = {
        profile: file.profile,
        chatId: file.chatId,
        token: file.token,
        fileName: file.fileName,
        mediaType: 'video/mp4' as const,
        durationSeconds: row.durationSeconds,
        width: dimension(row.width, 8192),
        height: dimension(row.height, 8192),
        ...(file.caption === undefined ? {} : {caption: file.caption}),
    };
    if (!thumbnailKeys.some((key) => key in row)) return base;
    if (!thumbnailKeys.every((key) => key in row))
        throw new Error('Incomplete prepared video thumbnail');
    const thumbnailToken = parsePreparedToken(row.thumbnailToken);
    if (
        thumbnailToken === file.token ||
        (row.thumbnailMediaType !== 'image/jpeg' && row.thumbnailMediaType !== 'image/png')
    )
        throw new Error('Invalid prepared video thumbnail');
    return {
        ...base,
        thumbnailToken,
        thumbnailMediaType: row.thumbnailMediaType,
        thumbnailWidth: dimension(row.thumbnailWidth, 512),
        thumbnailHeight: dimension(row.thumbnailHeight, 512),
    };
}
