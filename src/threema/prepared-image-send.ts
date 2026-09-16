import {parsePreparedFileSend, type PreparedFileSend} from './prepared-file-send.ts';
import {parsePreparedToken} from './prepare-file-command.ts';

export interface PreparedImageSend extends PreparedFileSend {
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    thumbnailToken: string;
    thumbnailMediaType: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    thumbnailWidth: number;
    thumbnailHeight: number;
}

/** Only trusted codec output may construct this command; handles/keys never cross IPC. */
export function parsePreparedImageSend(value: unknown): PreparedImageSend {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid prepared image');
    const row = value as Record<string, unknown>;
    const allowed = [
        'profile',
        'chatId',
        'token',
        'fileName',
        'mediaType',
        'caption',
        'thumbnailToken',
        'thumbnailMediaType',
        'width',
        'height',
        'thumbnailWidth',
        'thumbnailHeight',
    ];
    if (Object.keys(row).some((key) => !allowed.includes(key)))
        throw new Error('Invalid prepared image');
    const file = parsePreparedFileSend({
        profile: row.profile,
        chatId: row.chatId,
        token: row.token,
        fileName: row.fileName,
        mediaType: row.mediaType,
        ...(row.caption === undefined ? {} : {caption: row.caption}),
    });
    const thumbnailToken = parsePreparedToken(row.thumbnailToken);
    const dimension = (value: unknown, maximum: number): number => {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
            throw new Error('Invalid prepared image dimensions');
        return value as number;
    };
    const width = dimension(row.width, 8192),
        height = dimension(row.height, 8192);
    const thumbnailWidth = dimension(row.thumbnailWidth, 512);
    const thumbnailHeight = dimension(row.thumbnailHeight, 512);
    if (
        (file.mediaType !== 'image/png' &&
            file.mediaType !== 'image/jpeg' &&
            file.mediaType !== 'image/gif' &&
            file.mediaType !== 'image/webp') ||
        (row.thumbnailMediaType !== 'image/png' && row.thumbnailMediaType !== 'image/jpeg') ||
        file.token === thumbnailToken
    )
        throw new Error('Invalid prepared image format or tokens');
    return {
        ...file,
        mediaType: file.mediaType,
        thumbnailToken,
        thumbnailMediaType: row.thumbnailMediaType,
        width,
        height,
        thumbnailWidth,
        thumbnailHeight,
    };
}
