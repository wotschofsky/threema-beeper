import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath, link, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {Readable, Writable} from 'node:stream';
import type {FileHandle} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';

// Version 1: authenticated 8-byte magic + 12-byte nonce, ciphertext, 16-byte GCM tag.
const magic = Buffer.from('TBBKUP01');
const headerBytes = 20;
const tagBytes = 16;

function sink(file: FileHandle, position = 0): Writable {
    return new Writable({
        write(chunk: Buffer, _encoding, callback) {
            void (async () => {
                let offset = 0;
                while (offset < chunk.length) {
                    const {bytesWritten} = await file.write(
                        chunk,
                        offset,
                        chunk.length - offset,
                        position,
                    );
                    if (!bytesWritten) throw new Error('Incomplete archive write');
                    offset += bytesWritten;
                    position += bytesWritten;
                }
            })().then(() => callback(), callback);
        },
    });
}

async function publish(destination: string, write: (temporary: string) => Promise<void>) {
    const parent = dirname(destination);
    if (!isAbsolute(destination) || (await realpath(parent)) !== parent)
        throw new Error('Invalid backup destination');
    const info = await lstat(parent);
    if (
        !info.isDirectory() ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid())
    )
        throw new Error('Backup destination requires private owned directory');
    const temporary = join(parent, '.backup-' + randomUUID());
    try {
        await write(temporary);
        // Atomic publication with no overwrite, including symlink destinations.
        await link(temporary, destination);
        const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } finally {
        await unlink(temporary).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
}

/** Encrypt an archive stream. A separate 32-byte backup key is supplied by the caller. */
export async function encryptArchive(
    source: Readable,
    destination: string,
    key: Buffer,
): Promise<void> {
    if (key.length !== 32) throw new Error('Invalid backup key size');
    try {
        await publish(destination, async (temporary) => {
            const file = await open(temporary, 'wx', 0o600);
            try {
                const header = Buffer.concat([magic, randomBytes(12)]);
                const cipher = createCipheriv('aes-256-gcm', key, header.subarray(8));
                cipher.setAAD(header);
                await file.writeFile(header);
                await pipeline(source, cipher, sink(file, headerBytes));
                const tag = cipher.getAuthTag();
                // Append explicitly: stream position is independent of the descriptor's offset.
                const size = (await file.stat()).size;
                await file.write(tag, 0, tag.length, size);
                await file.sync();
            } finally {
                await file.close();
            }
        });
    } catch {
        source.destroy();
        throw new Error('Backup archive encryption failed');
    }
}

/** Authenticate the entire archive before publishing plaintext for an archive extractor. */
export async function decryptArchive(
    source: string,
    destination: string,
    key: Buffer,
): Promise<void> {
    if (key.length !== 32) throw new Error('Invalid backup key size');
    const file = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        const before = await file.stat();
        if (!before.isFile() || before.size < headerBytes + tagBytes) throw new Error();
        const header = Buffer.alloc(headerBytes),
            tag = Buffer.alloc(tagBytes);
        if (
            (await file.read(header, 0, headerBytes, 0)).bytesRead !== headerBytes ||
            !header.subarray(0, 8).equals(magic)
        )
            throw new Error();
        if ((await file.read(tag, 0, tagBytes, before.size - tagBytes)).bytesRead !== tagBytes)
            throw new Error();
        await publish(destination, async (temporary) => {
            const output = await open(temporary, 'wx', 0o600);
            try {
                const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
                decipher.setAAD(header);
                decipher.setAuthTag(tag);
                const ciphertext =
                    before.size === headerBytes + tagBytes
                        ? Readable.from([])
                        : file.createReadStream({
                              autoClose: false,
                              start: headerBytes,
                              end: before.size - tagBytes - 1,
                          });
                await pipeline(ciphertext, decipher, sink(output));
                const after = await file.stat();
                if (
                    after.size !== before.size ||
                    after.mtimeMs !== before.mtimeMs ||
                    after.ctimeMs !== before.ctimeMs
                )
                    throw new Error();
                await output.sync();
            } finally {
                await output.close();
            }
        });
    } catch {
        throw new Error('Backup archive authentication failed');
    } finally {
        await file.close();
    }
}
