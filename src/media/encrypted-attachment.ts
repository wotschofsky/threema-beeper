import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {constants, createReadStream, createWriteStream, openSync} from 'node:fs';
import {lstat, mkdtemp, open, rm} from 'node:fs/promises';
import {basename, isAbsolute, join} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {EncryptedFile} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/models/events/MessageEvent.js';

export interface AttachmentInput {
    bytes: number;
    sha256: string;
    mimeType: string;
    maxBytes: number;
    signal?: AbortSignal;
    /** Content sniffing policy. Must reject a MIME mismatch; receives at most the first 4096 bytes. */
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
}
export interface PreparedAttachment {
    spoolId: string;
    bytes: number;
    file: Omit<EncryptedFile, 'url'>;
    stream(): Readable;
    dispose(): Promise<void>;
}

/** Matrix v2 AES-CTR, with bounded streams and a private ciphertext spool. Never stores plaintext. */
export async function prepareAttachment(
    source: Readable,
    temporaryDirectory: string,
    input: AttachmentInput,
): Promise<PreparedAttachment> {
    if (
        !isAbsolute(temporaryDirectory) ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 0 ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > 1024 ** 3 ||
        input.bytes > input.maxBytes ||
        !/^[0-9a-f]{64}$/.test(input.sha256) ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mimeType) ||
        typeof input.verifyMime !== 'function'
    ) {
        source.destroy();
        throw new Error('Invalid attachment metadata or size limit');
    }
    let directory: string | undefined;
    const key = randomBytes(32);
    const iv = Buffer.alloc(16);
    randomBytes(8).copy(iv);
    const plainHash = createHash('sha256'),
        encryptedHash = createHash('sha256');
    const header = Buffer.alloc(4096);
    let headerLength = 0,
        bytes = 0;
    try {
        input.signal?.throwIfAborted();
        const parent = await lstat(temporaryDirectory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077)
            throw new Error('Attachment spool requires a private directory');
        directory = await mkdtemp(join(temporaryDirectory, 'attachment-'));
        const filename = join(directory, 'ciphertext');
        const validate = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                if (
                    !Buffer.isBuffer(chunk) ||
                    chunk.length > 1024 * 1024 ||
                    bytes + chunk.length > input.bytes
                ) {
                    callback(new Error('Attachment stream exceeds expected bounds'));
                    return;
                }
                bytes += chunk.length;
                plainHash.update(chunk);
                if (headerLength < header.length)
                    headerLength += chunk.copy(
                        header,
                        headerLength,
                        0,
                        header.length - headerLength,
                    );
                callback(null, chunk);
            },
        });
        const hashCiphertext = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                encryptedHash.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(
            source,
            validate,
            createCipheriv('aes-256-ctr', key, iv),
            hashCiphertext,
            createWriteStream(filename, {flags: 'wx', mode: 0o600}),
            {signal: input.signal},
        );
        if (bytes !== input.bytes || plainHash.digest('hex') !== input.sha256)
            throw new Error('Attachment size or SHA-256 mismatch');
        await input.verifyMime(header.subarray(0, headerLength), input.mimeType);
        input.signal?.throwIfAborted();
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        const file: Omit<EncryptedFile, 'url'> = {
            key: {
                kty: 'oct',
                key_ops: ['encrypt', 'decrypt'],
                alg: 'A256CTR',
                k: key.toString('base64url'),
                ext: true,
            },
            iv: iv.toString('base64').replace(/=+$/, ''),
            hashes: {sha256: encryptedHash.digest('base64').replace(/=+$/, '')},
            v: 'v2',
        };
        const ownedDirectory = directory;
        let disposed = false;
        const readers = new Set<Readable>();
        return {
            spoolId: basename(ownedDirectory),
            bytes,
            file,
            stream() {
                if (disposed) throw new Error('Attachment spool already disposed');
                const stream = createReadStream(filename, {
                    fd: openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW),
                    autoClose: true,
                    highWaterMark: 64 * 1024,
                });
                readers.add(stream);
                stream.once('close', () => readers.delete(stream));
                return stream;
            },
            async dispose() {
                disposed = true;
                for (const reader of readers) reader.destroy();
                await rm(ownedDirectory, {recursive: true, force: true});
            },
        };
    } catch (error) {
        source.destroy();
        if (directory) await rm(directory, {recursive: true, force: true});
        throw error;
    } finally {
        key.fill(0);
        header.fill(0);
    }
}
