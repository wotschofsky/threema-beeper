import {parsePrepareFile, parsePreparedToken} from './prepare-file-command.ts';
export interface PreparedFileSend {
    profile: string;
    chatId: string;
    token: string;
    fileName: string;
    mediaType: string;
    caption?: string;
    /** Trusted prepared AAC metadata; absent for ordinary files. Seconds, not Matrix milliseconds. */
    audioDurationSeconds?: number;
}
export function parsePreparedFileSend(value: unknown): PreparedFileSend {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid prepared send');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some(
            (key) =>
                ![
                    'profile',
                    'chatId',
                    'token',
                    'fileName',
                    'mediaType',
                    'caption',
                    'audioDurationSeconds',
                ].includes(key),
        ) ||
        (row.audioDurationSeconds !== undefined &&
            (row.mediaType !== 'audio/mp4' ||
                typeof row.audioDurationSeconds !== 'number' ||
                !Number.isFinite(row.audioDurationSeconds) ||
                row.audioDurationSeconds <= 0 ||
                row.audioDurationSeconds > 10000)) ||
        typeof row.fileName !== 'string' ||
        !row.fileName ||
        Buffer.byteLength(row.fileName) > 1024 ||
        /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(row.fileName) ||
        row.fileName === '.' ||
        row.fileName === '..' ||
        typeof row.mediaType !== 'string' ||
        row.mediaType.length > 127 ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(row.mediaType) ||
        (row.caption !== undefined &&
            (typeof row.caption !== 'string' || Buffer.byteLength(row.caption) > 1024 * 1024))
    )
        throw new Error('Invalid prepared send');
    const {profile, chatId} = parsePrepareFile({
        profile: row.profile,
        chatId: row.chatId,
        bytes: 0,
    });
    return {
        profile,
        chatId,
        token: parsePreparedToken(row.token),
        fileName: row.fileName,
        mediaType: row.mediaType,
        ...(row.audioDurationSeconds === undefined
            ? {}
            : {audioDurationSeconds: row.audioDurationSeconds as number}),
        ...(row.caption === undefined ? {} : {caption: row.caption as string}),
    };
}
