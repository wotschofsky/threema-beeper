import {createHash, webcrypto} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {Readable} from 'node:stream';

import type {CopyableFileStorage, StoredFileHandle} from '~/common/file-storage';
import {FileChunkNonce} from '~/common/node/file-storage/file-crypto';
import {
    CHUNK_AUTH_TAG_BYTES,
    CHUNK_SIZE_BYTES,
    FILE_STORAGE_FORMAT,
} from '~/common/node/file-storage/system-file-storage';

/** Worker-local stream: StoredFileHandle and its encryption key must never cross IPC. */
export function openNodeStoredFile(
    storage: Pick<CopyableFileStorage, 'getRawPath'>,
    handle: StoredFileHandle,
    maximumBytes: number,
    signal?: AbortSignal,
): Readable {
    if (
        handle.storageFormatVersion !== FILE_STORAGE_FORMAT.V1 ||
        !/^[0-9a-f]{48}$/u.test(handle.fileId) ||
        !Number.isSafeInteger(handle.unencryptedByteCount) ||
        handle.unencryptedByteCount < 0 ||
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 0 ||
        maximumBytes > 1024 ** 3 ||
        handle.unencryptedByteCount > maximumBytes
    ) {
        throw new Error('Unsupported file handle or stream limit');
    }
    const snapshot = {...handle};
    async function* chunks(): AsyncGenerator<Uint8Array> {
        signal?.throwIfAborted();
        const filename = await storage.getRawPath(snapshot.fileId);
        // eslint-disable-next-line no-bitwise -- Combine read-only and no-follow file flags.
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const count = Math.ceil(snapshot.unencryptedByteCount / CHUNK_SIZE_BYTES);
            const stat = await file.stat();
            if (
                !stat.isFile() ||
                stat.size !== snapshot.unencryptedByteCount + count * CHUNK_AUTH_TAG_BYTES
            ) {
                throw new Error('Stored file length mismatch');
            }
            const key = await webcrypto.subtle.importKey(
                'raw',
                snapshot.encryptionKey.unwrap(),
                {name: 'AES-GCM'},
                false,
                ['decrypt'],
            );
            const nonce = new FileChunkNonce(snapshot.fileId);
            let remaining = snapshot.unencryptedByteCount;
            for (let index = 0; index < count; index++) {
                signal?.throwIfAborted();
                const size = Math.min(CHUNK_SIZE_BYTES, remaining);
                const encrypted = new Uint8Array(size + CHUNK_AUTH_TAG_BYTES);
                let offset = 0;
                while (offset < encrypted.byteLength) {
                    signal?.throwIfAborted();
                    const read = await file.read(
                        encrypted,
                        offset,
                        encrypted.byteLength - offset,
                        null,
                    );
                    if (read.bytesRead === 0) {
                        throw new Error('Stored file was truncated');
                    }
                    offset += read.bytesRead;
                }
                const plain = new Uint8Array(
                    await webcrypto.subtle.decrypt(
                        {
                            name: 'AES-GCM',
                            iv: nonce.next(index === count - 1),
                            tagLength: CHUNK_AUTH_TAG_BYTES * 8,
                        },
                        key,
                        encrypted,
                    ),
                );
                if (plain.byteLength !== size) {
                    throw new Error('Decrypted chunk length mismatch');
                }
                remaining -= size;
                signal?.throwIfAborted();
                yield plain;
            }
            if ((await file.read(new Uint8Array(1), 0, 1, null)).bytesRead !== 0) {
                throw new Error('Stored file grew during read');
            }
        } finally {
            await file.close();
        }
    }
    return Readable.from(chunks(), {objectMode: false, highWaterMark: 64 * 1024, signal});
}

/** Authenticate/hash the complete immutable local file before permitting Matrix upload. */
export async function describeNodeStoredFile(
    storage: Pick<CopyableFileStorage, 'getRawPath'>,
    handle: StoredFileHandle,
    maximumBytes: number,
    signal?: AbortSignal,
): Promise<{bytes: number; sha256: string}> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of openNodeStoredFile(storage, handle, maximumBytes, signal)) {
        hash.update(chunk as Uint8Array);
        bytes += (chunk as Uint8Array).byteLength;
    }
    return {bytes, sha256: hash.digest('hex')};
}
