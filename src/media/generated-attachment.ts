import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {lstat, mkdtemp, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {PassThrough, Transform, type Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {prepareOutboundAttachment} from './outbound-attachment.ts';

/** Capture codec output directly as ciphertext, then use the verified attachment reader. */
export async function prepareGeneratedAttachment<T>(
    produce: (output: Writable) => Promise<T>,
    parent: string,
    options: {
        maximumBytes: number;
        mimeType: string;
        signal?: AbortSignal;
        verifyMime: (header: Buffer, declared: string) => Promise<void>;
    },
): Promise<{metadata: T; attachment: Awaited<ReturnType<typeof prepareOutboundAttachment>>}> {
    if (
        !isAbsolute(parent) ||
        !Number.isSafeInteger(options.maximumBytes) ||
        options.maximumBytes < 1 ||
        options.maximumBytes > 1024 ** 3
    )
        throw new Error('Invalid generated attachment configuration');
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error('Generated attachment requires private storage');
    options.signal?.throwIfAborted();
    const directory = await mkdtemp(join(parent, 'outbound-attachment-'));
    const filename = join(directory, 'ciphertext');
    const key = randomBytes(32),
        iv = Buffer.alloc(16);
    randomBytes(8).copy(iv);
    const output = new PassThrough();
    let bytes = 0;
    const hash = createHash('sha256');
    const bound = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > options.maximumBytes)
                callback(new Error('Generated attachment exceeds limit'));
            else callback(null, chunk);
        },
    });
    const digest = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    let prepared: Awaited<ReturnType<typeof prepareOutboundAttachment>> | undefined;
    try {
        const stored = pipeline(
            output,
            bound,
            createCipheriv('aes-256-ctr', key, iv),
            digest,
            createWriteStream(filename, {flags: 'wx', mode: 0o600}),
            {signal: options.signal},
        );
        const generated = Promise.resolve()
            .then(() => produce(output))
            .then((metadata) => {
                output.end();
                return metadata;
            })
            .catch((error: unknown) => {
                output.destroy();
                throw error;
            });
        const results = await Promise.allSettled([generated, stored]);
        if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled')
            throw new Error('Generated attachment preparation failed');
        options.signal?.throwIfAborted();
        prepared = await prepareOutboundAttachment(createReadStream(filename), parent, {
            bytes,
            maxBytes: options.maximumBytes,
            mimeType: options.mimeType,
            verifyMime: options.verifyMime,
            signal: options.signal,
            file: {
                v: 'v2',
                key: {
                    kty: 'oct',
                    alg: 'A256CTR',
                    key_ops: ['decrypt'],
                    k: key.toString('base64url'),
                },
                iv: iv.toString('base64'),
                hashes: {sha256: hash.digest('base64')},
            },
        });
        // Only the verified reader's ciphertext spool survives successful handoff.
        await rm(directory, {recursive: true, force: true});
        return {metadata: results[0].value, attachment: prepared};
    } catch {
        await prepared?.dispose();
        await rm(directory, {recursive: true, force: true});
        throw new Error('Generated attachment preparation failed');
    } finally {
        key.fill(0);
        output.destroy();
    }
}
