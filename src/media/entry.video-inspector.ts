import {createInterface} from 'node:readline';
import {
    Input,
    StreamSource,
    ALL_FORMATS,
    EncodedPacketSink,
} from '../../.local/sources/threema-desktop/apps/desktop/node_modules/mediabunny/dist/modules/src/index.js';
import {parseVideoSourceMetadata} from './video-source-metadata.ts';

// Parent starts this executable under media-limits. No profile, file path or key is passed.
const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
const iterator = lines[Symbol.asyncIterator]();
let input: Input | undefined;
try {
    const first = await iterator.next();
    const init = JSON.parse(first.value ?? 'null');
    if (
        !init ||
        init.type !== 'init' ||
        !Number.isSafeInteger(init.bytes) ||
        init.bytes < 1 ||
        init.bytes > 1024 ** 3 ||
        !Number.isSafeInteger(init.maximumDurationSeconds) ||
        init.maximumDurationSeconds < 1 ||
        init.maximumDurationSeconds > 10000
    )
        throw new Error('Invalid initialization');
    let sequence = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const read = (start: number, end: number): Promise<Uint8Array> => {
        const pending = queue.then(async () => {
            const id = ++sequence;
            process.stdout.write(JSON.stringify({type: 'read', id, start, end}) + '\n');
            const line = await iterator.next();
            const result = JSON.parse(line.value ?? 'null');
            if (
                !result ||
                result.type !== 'data' ||
                result.id !== id ||
                typeof result.data !== 'string' ||
                result.data.length > 87384
            )
                throw new Error('Invalid range response');
            const bytes = Buffer.from(result.data, 'base64');
            if (bytes.length !== end - start || bytes.toString('base64') !== result.data)
                throw new Error('Invalid range bytes');
            return bytes;
        });
        queue = pending;
        return pending;
    };
    const source = new StreamSource({
        getSize: () => init.bytes,
        maxCacheSize: 1024 * 1024,
        prefetchProfile: 'none',
        read: (start, end) => {
            let offset = start;
            return new ReadableStream<Uint8Array>({
                async pull(controller) {
                    const next = Math.min(end, offset + 65536);
                    const bytes = await read(offset, next);
                    offset = next;
                    controller.enqueue(bytes);
                    if (offset === end) controller.close();
                },
            });
        },
    });
    input = new Input({formats: ALL_FORMATS, source});
    const durationSeconds = await input.computeDuration();
    const firstTimestamp = await input.getFirstTimestamp();
    const tracks = await input.getTracks();
    if (tracks.length > 128) throw new Error('Too many tracks');
    let thumbnail: {trackIndex: number; timestamp: number} | undefined;
    if (init.thumbnail === true) {
        const primary = await input.getPrimaryVideoTrack();
        if (!primary) throw new Error('Missing thumbnail track');
        const sink = new EncodedPacketSink(primary);
        const packet =
            (await sink.getPacket(durationSeconds * 0.1, {metadataOnly: true})) ??
            (await sink.getFirstPacket({metadataOnly: true}));
        if (!packet) throw new Error('Missing thumbnail packet');
        thumbnail = {trackIndex: tracks.indexOf(primary), timestamp: packet.timestamp};
    }
    const metadata = parseVideoSourceMetadata(
        {
            ...(thumbnail ? {thumbnail} : {}),
            durationSeconds,
            firstTimestamp,
            tracks: await Promise.all(
                tracks.map(async (track, index) => ({
                    index,
                    type: track.type,
                    codec: track.codec,
                    firstTimestamp: await track.getFirstTimestamp(),
                    ...(track.isVideoTrack()
                        ? {
                              width: track.displayWidth,
                              height: track.displayHeight,
                              codedWidth: track.codedWidth,
                              codedHeight: track.codedHeight,
                              rotation: track.rotation,
                          }
                        : track.isAudioTrack()
                          ? {sampleRate: track.sampleRate, channels: track.numberOfChannels}
                          : {}),
                })),
            ),
        },
        init.maximumDurationSeconds,
    );
    input.dispose();
    input = undefined;
    await queue;
    process.stdout.write(JSON.stringify({type: 'result', metadata}) + '\n');
    if (!(await iterator.next()).done) throw new Error('Unexpected trailing input');
} catch {
    process.exitCode = 1;
    process.stderr.write('Video metadata inspection failed\n');
} finally {
    input?.dispose();
    lines.close();
    process.stdin.destroy();
}
