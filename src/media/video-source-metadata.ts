export interface VideoSourceMetadata {
    thumbnail?: {trackIndex: number; timestamp: number};
    durationSeconds: number;
    firstTimestamp: number;
    tracks: ({index: number; codec: string; firstTimestamp: number} & (
        | {
              type: 'video';
              width: number;
              height: number;
              codedWidth: number;
              codedHeight: number;
              rotation: number;
          }
        | {type: 'audio'; sampleRate: number; channels: number}
    ))[];
}

/** Validate all parser output before it can influence codec commands or durable metadata. */
export function parseVideoSourceMetadata(
    value: unknown,
    maximumDurationSeconds: number,
): VideoSourceMetadata {
    const object = (value: unknown, keys: readonly string[]) => {
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).some((key) => !keys.includes(key))
        )
            throw new Error('Invalid video source metadata');
        return value as Record<string, unknown>;
    };
    const integer = (value: unknown, minimum: number, maximum: number): number => {
        if (
            !Number.isSafeInteger(value) ||
            (value as number) < minimum ||
            (value as number) > maximum
        )
            throw new Error('Invalid video source bounds');
        return value as number;
    };
    integer(maximumDurationSeconds, 1, 10000);
    const time = (value: unknown): number => {
        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            Math.abs(value) > maximumDurationSeconds
        )
            throw new Error('Invalid video source timing');
        return value;
    };
    const row = object(value, ['durationSeconds', 'firstTimestamp', 'tracks', 'thumbnail']);
    const durationSeconds = time(row.durationSeconds),
        firstTimestamp = time(row.firstTimestamp);
    if (
        durationSeconds <= 0 ||
        firstTimestamp > durationSeconds ||
        !Array.isArray(row.tracks) ||
        row.tracks.length < 1 ||
        row.tracks.length > 128
    )
        throw new Error('Invalid video source tracks');
    const tracks: VideoSourceMetadata['tracks'] = row.tracks.map((value, index) => {
        const track = object(value, [
            'index',
            'codec',
            'type',
            'firstTimestamp',
            'width',
            'height',
            'codedWidth',
            'codedHeight',
            'rotation',
            'sampleRate',
            'channels',
        ]);
        if (
            track.index !== index ||
            typeof track.codec !== 'string' ||
            !/^[a-z0-9_-]{1,64}$/.test(track.codec)
        )
            throw new Error('Invalid video source codec or index');
        const timestamp = time(track.firstTimestamp);
        if (timestamp < firstTimestamp || timestamp > durationSeconds)
            throw new Error('Invalid video track timing');
        const base = {index, codec: track.codec, firstTimestamp: timestamp};
        if (track.type === 'video') {
            object(value, [
                'index',
                'codec',
                'type',
                'firstTimestamp',
                'width',
                'height',
                'codedWidth',
                'codedHeight',
                'rotation',
            ]);
            const rotation = integer(track.rotation, 0, 270);
            if (rotation % 90 !== 0) throw new Error('Invalid video rotation');
            const width = integer(track.width, 1, 8192),
                height = integer(track.height, 1, 8192),
                codedWidth = integer(track.codedWidth, 1, 8192),
                codedHeight = integer(track.codedHeight, 1, 8192);
            if (
                width !== (rotation % 180 ? codedHeight : codedWidth) ||
                height !== (rotation % 180 ? codedWidth : codedHeight)
            )
                throw new Error('Conflicting video dimensions');
            return {...base, type: 'video', width, height, codedWidth, codedHeight, rotation};
        }
        if (track.type !== 'audio') throw new Error('Unsupported video source track');
        object(value, ['index', 'codec', 'type', 'firstTimestamp', 'sampleRate', 'channels']);
        return {
            ...base,
            type: 'audio',
            sampleRate: integer(track.sampleRate, 1, 384000),
            channels: integer(track.channels, 1, 32),
        };
    });
    if (
        !tracks.some((track) => track.type === 'video') ||
        Math.min(...tracks.map((track) => track.firstTimestamp)) !== firstTimestamp
    )
        throw new Error('Missing primary video or source start');
    let thumbnail: VideoSourceMetadata['thumbnail'];
    if (row.thumbnail !== undefined) {
        const selected = object(row.thumbnail, ['trackIndex', 'timestamp']);
        const trackIndex = integer(selected.trackIndex, 0, tracks.length - 1);
        const primary = tracks.find((track) => track.type === 'video')!;
        const timestamp = time(selected.timestamp);
        if (
            trackIndex !== primary.index ||
            timestamp < primary.firstTimestamp ||
            timestamp > durationSeconds
        )
            throw new Error('Invalid thumbnail sample');
        thumbnail = {trackIndex, timestamp};
    }
    return {durationSeconds, firstTimestamp, tracks, ...(thumbnail ? {thumbnail} : {})};
}
