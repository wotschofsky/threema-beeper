import {PassThrough, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {runCodecProcess, type CodecProcessOptions} from './codec-process.ts';
import {parseVideoSourceMetadata, type VideoSourceMetadata} from './video-source-metadata.ts';

/** Bounded, isolated use of Desktop's pure container parser. Caller retains source ownership. */
export async function inspectVideoSource(
    source: {bytes: number; read: (start: number, end: number) => Promise<Buffer>},
    options: Omit<
        CodecProcessOptions,
        'args' | 'maximumInputBytes' | 'maximumOutputBytes' | 'allowEarlyInputClose'
    > & {
        maximumDurationSeconds: number;
        maximumReadBytes: number;
        thumbnail?: boolean;
    },
): Promise<VideoSourceMetadata> {
    const bytes = source.bytes;
    const read = source.read.bind(source);
    options = {...options};
    const integer = (n: number, minimum: number, maximum: number) =>
        Number.isSafeInteger(n) && n >= minimum && n <= maximum;
    if (
        (options.thumbnail !== undefined && typeof options.thumbnail !== 'boolean') ||
        !integer(bytes, 1, 1024 ** 3) ||
        !integer(options.maximumDurationSeconds, 1, 10000) ||
        !integer(options.maximumReadBytes, 1, 256 * 1024 * 1024)
    )
        throw new Error('Invalid video inspection limits');
    const input = new PassThrough();
    let pending = '',
        sequence = 0,
        readBytes = 0;
    let metadata: VideoSourceMetadata | undefined;
    let serving: Promise<void> = Promise.resolve();
    const serve = async (line: string) => {
        if (metadata || !line) throw new Error('Invalid video inspection response');
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row))
            throw new Error('Invalid video inspection response');
        if (row.type === 'result') {
            if (Object.keys(row).some((key) => !['type', 'metadata'].includes(key)))
                throw new Error('Invalid video inspection result');
            metadata = parseVideoSourceMetadata(row.metadata, options.maximumDurationSeconds);
            if (!!metadata.thumbnail !== (options.thumbnail === true))
                throw new Error('Unexpected thumbnail inspection result');
            input.end();
            return;
        }
        if (
            row.type !== 'read' ||
            Object.keys(row).some((key) => !['type', 'id', 'start', 'end'].includes(key)) ||
            row.id !== sequence + 1 ||
            ++sequence > 65536 ||
            !integer(row.start, 0, bytes - 1) ||
            !integer(row.end, row.start + 1, Math.min(bytes, row.start + 65536))
        )
            throw new Error('Invalid video inspection range');
        readBytes += row.end - row.start;
        if (readBytes > options.maximumReadBytes)
            throw new Error('Video inspection read budget exceeded');
        options.signal?.throwIfAborted();
        const result = await read(row.start, row.end);
        try {
            if (
                input.destroyed ||
                !Buffer.isBuffer(result) ||
                result.length !== row.end - row.start
            )
                throw new Error('Invalid video source read');
            options.signal?.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
                input.write(
                    JSON.stringify({type: 'data', id: row.id, data: result.toString('base64')}) +
                        '\n',
                    (error) => (error ? reject(error) : resolve()),
                );
            });
        } finally {
            if (Buffer.isBuffer(result)) result.fill(0);
        }
    };
    const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            serving = (async () => {
                pending += chunk.toString('utf8');
                let newline: number;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    if (newline > 65536) throw new Error('Video inspection line exceeds limit');
                    const line = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    await serve(line);
                }
                if (pending.length > 65536) throw new Error('Video inspection line exceeds limit');
            })();
            void serving.then(
                () => callback(),
                () => callback(new Error('Invalid video inspection response')),
            );
        },
    });
    input.write(
        JSON.stringify({
            type: 'init',
            bytes,
            maximumDurationSeconds: options.maximumDurationSeconds,
            thumbnail: options.thumbnail === true,
        }) + '\n',
    );
    try {
        await runCodecProcess(input, output, {
            ...options,
            maximumInputBytes: Math.ceil((options.maximumReadBytes * 4) / 3) + 4 * 1024 * 1024,
            maximumOutputBytes: 8 * 1024 * 1024,
            allowEarlyInputClose: false,
            args: [
                '--jitless',
                '--max-old-space-size=64',
                fileURLToPath(new URL('../../.local/video-inspector/entry.mjs', import.meta.url)),
            ],
        });
        if (pending || !metadata) throw new Error('Incomplete video inspection');
        return metadata;
    } finally {
        input.destroy();
        output.destroy();
        await serving.catch(() => {});
    }
}
