import {imageThumbnailType} from '../media/image-format.ts';

/** Durable canonical output only. Never persist worker tokens or encryption keys here. */
export interface ImageProjection {
    kind: 'image';
    fileName: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    bytes: number;
    width: number;
    height: number;
    thumbnailMediaType: 'image/png' | 'image/jpeg';
    thumbnailBytes: number;
    thumbnailWidth: number;
    thumbnailHeight: number;
    caption?: string;
}
export function parseImageProjection(value: unknown): ImageProjection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid image projection');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some(
            (key) =>
                ![
                    'kind',
                    'fileName',
                    'mediaType',
                    'bytes',
                    'width',
                    'height',
                    'thumbnailMediaType',
                    'thumbnailBytes',
                    'thumbnailWidth',
                    'thumbnailHeight',
                    'caption',
                ].includes(key),
        ) ||
        row.kind !== 'image' ||
        (row.mediaType !== 'image/png' &&
            row.mediaType !== 'image/jpeg' &&
            row.mediaType !== 'image/gif' &&
            row.mediaType !== 'image/webp') ||
        (row.thumbnailMediaType !== undefined &&
            row.thumbnailMediaType !== 'image/png' &&
            row.thumbnailMediaType !== 'image/jpeg') ||
        typeof row.fileName !== 'string' ||
        !row.fileName ||
        Buffer.byteLength(row.fileName) > 1024 ||
        /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(row.fileName) ||
        row.fileName === '.' ||
        row.fileName === '..' ||
        (row.caption !== undefined &&
            (typeof row.caption !== 'string' || Buffer.byteLength(row.caption) > 65536))
    )
        throw new Error('Invalid image projection');
    const count = (key: string, max: number) => {
        const n = row[key];
        if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > max)
            throw new Error('Invalid image projection bounds');
        return n as number;
    };
    const width = count('width', 8192),
        height = count('height', 8192);
    return {
        kind: 'image',
        fileName: row.fileName,
        mediaType: row.mediaType,
        bytes: count('bytes', 1024 ** 3),
        width,
        height,
        // Schema 9 rows omitted this field and used a fixed main-to-thumbnail mapping.
        thumbnailMediaType: row.thumbnailMediaType ?? imageThumbnailType(row.mediaType),
        thumbnailBytes: count('thumbnailBytes', 1024 ** 3),
        thumbnailWidth: count('thumbnailWidth', 512),
        thumbnailHeight: count('thumbnailHeight', 512),
        ...(row.caption === undefined ? {} : {caption: row.caption as string}),
    };
}
