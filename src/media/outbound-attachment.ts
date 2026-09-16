import {createDecipheriv, createHash, timingSafeEqual} from 'node:crypto';
import {constants, createReadStream, createWriteStream, openSync} from 'node:fs';
import {lstat, mkdtemp, open, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {addAbortSignal, Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export interface OutboundAttachmentInput {
    bytes?: number;
    maxBytes: number;
    mimeType: string;
    file: {
        v: string;
        key: {kty: string; alg: string; k: string; key_ops: string[]};
        iv: string;
        hashes: {sha256: string};
    };
    signal?: AbortSignal;
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
}
function decode(value: string, length: number, url: boolean): Buffer {
    const pattern = url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/;
    if (typeof value !== 'string' || !pattern.test(value))
        throw new Error('Invalid attachment encoding');
    const decoded = Buffer.from(value, url ? 'base64url' : 'base64');
    if (
        decoded.length !== length ||
        decoded.toString(url ? 'base64url' : 'base64').replace(/=+$/, '') !==
            value.replace(/=+$/, '')
    )
        throw new Error('Invalid attachment encoding');
    return decoded;
}

/** Validate ciphertext before exposing plaintext. The private spool contains ciphertext only. */
export async function prepareOutboundAttachment(
    source: Readable,
    parent: string,
    input: OutboundAttachmentInput,
): Promise<{
    bytes: number;
    read(start: number, end: number): Promise<Buffer>;
    stream(): Readable;
    dispose(): Promise<void>;
}> {
    let directory: string | undefined, key: Buffer | undefined;
    const readers = new Set<Readable>();
    try {
        input = {...input, file: structuredClone(input.file)};
        if (
            !isAbsolute(parent) ||
            !Number.isSafeInteger(input.maxBytes) ||
            input.maxBytes < 1 ||
            input.maxBytes > 1024 ** 3 ||
            (input.bytes !== undefined &&
                (!Number.isSafeInteger(input.bytes) ||
                    input.bytes < 0 ||
                    input.bytes > input.maxBytes)) ||
            !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mimeType) ||
            typeof input.verifyMime !== 'function' ||
            input.file?.v !== 'v2' ||
            input.file.key?.kty !== 'oct' ||
            input.file.key.alg !== 'A256CTR' ||
            !Array.isArray(input.file.key.key_ops) ||
            !input.file.key.key_ops.includes('decrypt')
        )
            throw new Error('Invalid outbound attachment');
        key = decode(input.file.key.k, 32, true);
        const iv = decode(input.file.iv, 16, false),
            expected = decode(input.file.hashes?.sha256, 32, false);
        input.signal?.throwIfAborted();
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
            throw new Error('Outbound attachment requires a private spool');
        directory = await mkdtemp(join(parent, 'outbound-attachment-'));
        const filename = join(directory, 'ciphertext');
        const hash = createHash('sha256');
        let bytes = 0;
        const bounds = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                if (
                    !Buffer.isBuffer(chunk) ||
                    chunk.length > 1024 * 1024 ||
                    bytes + chunk.length > (input.bytes ?? input.maxBytes)
                )
                    return callback(new Error('Outbound attachment exceeds size limit'));
                bytes += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(source, bounds, createWriteStream(filename, {flags: 'wx', mode: 0o600}), {
            signal: input.signal,
        });
        if (
            (input.bytes !== undefined && bytes !== input.bytes) ||
            !timingSafeEqual(hash.digest(), expected)
        )
            throw new Error('Outbound attachment size or hash mismatch');
        // Only inspect plaintext after the complete ciphertext hash has been checked.
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const header = Buffer.alloc(Math.min(4096, bytes));
        let plaintext: Buffer | undefined;
        try {
            await handle.read(header, 0, header.length, 0);
            plaintext = createDecipheriv('aes-256-ctr', key, iv).update(header);
            await input.verifyMime(plaintext, input.mimeType);
        } finally {
            header.fill(0);
            plaintext?.fill(0);
            await handle.close();
        }
        input.signal?.throwIfAborted();
        const ownedDirectory = directory,
            ownedKey = key;
        let disposed = false;
        const rangeReads = new Set<Promise<Buffer>>();
        return {
            bytes,
            /** Bounded random access for container metadata; only verified ciphertext is read. */
            read(start: number, end: number): Promise<Buffer> {
                const run = async () => {
                    if (disposed) throw new Error('Outbound attachment disposed');
                    input.signal?.throwIfAborted();
                    if (
                        !Number.isSafeInteger(start) ||
                        !Number.isSafeInteger(end) ||
                        start < 0 ||
                        end <= start ||
                        end > bytes ||
                        end - start > 1024 * 1024 ||
                        rangeReads.size >= 4
                    )
                        throw new Error('Invalid attachment range or concurrency');
                    const offset = start % 16;
                    const blockStart = start - offset;
                    const counter = BigInt('0x' + iv.toString('hex')) + BigInt(blockStart / 16);
                    if (counter + BigInt(Math.floor((end - blockStart - 1) / 16)) >= 1n << 128n)
                        throw new Error('Attachment counter overflow');
                    const rangeIv = Buffer.from(counter.toString(16).padStart(32, '0'), 'hex');
                    const encrypted = Buffer.alloc(end - blockStart);
                    let plaintext: Buffer | undefined;
                    let result: Buffer | undefined;
                    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
                    try {
                        let received = 0;
                        while (received < encrypted.length) {
                            if (disposed) throw new Error('Outbound attachment disposed');
                            input.signal?.throwIfAborted();
                            const result = await handle.read(
                                encrypted,
                                received,
                                encrypted.length - received,
                                blockStart + received,
                            );
                            if (!result.bytesRead) throw new Error('Attachment range is truncated');
                            received += result.bytesRead;
                        }
                        if (disposed) throw new Error('Outbound attachment disposed');
                        input.signal?.throwIfAborted();
                        const decipher = createDecipheriv('aes-256-ctr', ownedKey, rangeIv);
                        try {
                            plaintext = Buffer.concat([
                                decipher.update(encrypted),
                                decipher.final(),
                            ]);
                            result = Buffer.from(plaintext.subarray(offset));
                        } finally {
                            decipher.destroy();
                        }
                    } finally {
                        encrypted.fill(0);
                        plaintext?.fill(0);
                        rangeIv.fill(0);
                        try {
                            await handle.close();
                        } catch (error) {
                            result?.fill(0);
                            throw error;
                        }
                    }
                    try {
                        if (disposed) throw new Error('Outbound attachment disposed');
                        input.signal?.throwIfAborted();
                        return result!;
                    } catch (error) {
                        result?.fill(0);
                        throw error;
                    }
                };
                const pending = run();
                rangeReads.add(pending);
                void pending.then(
                    () => rangeReads.delete(pending),
                    () => rangeReads.delete(pending),
                );
                return pending;
            },
            stream() {
                if (disposed) throw new Error('Outbound attachment disposed');
                input.signal?.throwIfAborted();
                const encrypted = createReadStream(filename, {
                    fd: openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW),
                    autoClose: true,
                    highWaterMark: 64 * 1024,
                });
                const decipher = createDecipheriv('aes-256-ctr', ownedKey, iv);
                const output = Readable.from(
                    (async function* () {
                        try {
                            for await (const chunk of encrypted)
                                yield decipher.update(chunk as Buffer);
                            yield decipher.final();
                        } finally {
                            encrypted.destroy();
                            decipher.destroy();
                        }
                    })(),
                    {objectMode: false},
                );
                readers.add(output);
                output.once('close', () => {
                    readers.delete(output);
                    encrypted.destroy();
                });
                if (input.signal) addAbortSignal(input.signal, output);
                return output;
            },
            async dispose() {
                disposed = true;
                for (const reader of readers) reader.destroy();
                await Promise.allSettled([...rangeReads]);
                ownedKey.fill(0);
                await rm(ownedDirectory, {recursive: true, force: true});
            },
        };
    } catch (error) {
        source.destroy();
        key?.fill(0);
        if (directory) await rm(directory, {recursive: true, force: true});
        throw error;
    }
}
