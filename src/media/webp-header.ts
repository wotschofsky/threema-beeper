/** Inspect a bounded RIFF prefix. Complete decoding remains the codec's responsibility. */
export function webpDimensions(header: Buffer, bytes: number): {width: number; height: number} {
    if (
        header.length < 20 ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'WEBP' ||
        header.readUInt32LE(4) + 8 !== bytes
    )
        throw new Error('Invalid WebP container');
    let offset = 12;
    while (offset + 8 <= header.length) {
        const type = header.toString('ascii', offset, offset + 4);
        const size = header.readUInt32LE(offset + 4);
        const data = offset + 8;
        if (data + size > bytes) break;
        if (type === 'VP8X' && size === 10 && data + 10 <= header.length) {
            return {
                width: 1 + header.readUIntLE(data + 4, 3),
                height: 1 + header.readUIntLE(data + 7, 3),
            };
        }
        if (type === 'VP8L' && size >= 5 && data + 5 <= header.length && header[data] === 0x2f) {
            const packed = header.readUInt32LE(data + 1);
            if (packed >>> 29 !== 0) break;
            return {width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff)};
        }
        if (
            type === 'VP8 ' &&
            size >= 10 &&
            data + 10 <= header.length &&
            header[data + 3] === 0x9d &&
            header[data + 4] === 0x01 &&
            header[data + 5] === 0x2a
        ) {
            return {
                width: header.readUInt16LE(data + 6) & 0x3fff,
                height: header.readUInt16LE(data + 8) & 0x3fff,
            };
        }
        offset = data + size + (size & 1);
    }
    throw new Error('WebP dimensions not found within bounded header');
}
