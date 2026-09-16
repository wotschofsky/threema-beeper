import {constants, createReadStream, openSync} from 'node:fs';
import {lstat, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {createHash} from 'node:crypto';
import type {PreparedAttachment} from './encrypted-attachment.ts';

export class MissingAttachmentSpool extends Error {
    constructor() {
        super('Attachment recovery spool is missing');
    }
}

async function spoolStat(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingAttachmentSpool();
        throw error;
    }
}

export type AttachmentDescriptor = Pick<PreparedAttachment, 'spoolId' | 'bytes' | 'file'>;

/** Reopen only private, complete ciphertext matching its protected descriptor. */
export async function restoreAttachment(
    parent: string,
    descriptor: AttachmentDescriptor,
): Promise<PreparedAttachment> {
    if (
        !isAbsolute(parent) ||
        !/^attachment-[A-Za-z0-9]{6}$/.test(descriptor.spoolId) ||
        !Number.isSafeInteger(descriptor.bytes) ||
        descriptor.bytes < 0 ||
        descriptor.bytes > 1024 ** 3 ||
        descriptor.file.v !== 'v2' ||
        descriptor.file.key.alg !== 'A256CTR' ||
        Buffer.from(descriptor.file.key.k, 'base64url').length !== 32 ||
        Buffer.from(descriptor.file.iv, 'base64').length !== 16 ||
        Buffer.from(descriptor.file.hashes.sha256, 'base64').length !== 32
    )
        throw new Error('Invalid attachment recovery descriptor');
    const directory = join(parent, descriptor.spoolId),
        filename = join(directory, 'ciphertext');
    for (const path of [parent, directory]) {
        const stat = path === parent ? await lstat(path) : await spoolStat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
            throw new Error('Attachment recovery requires private directories');
    }
    const stat = await spoolStat(filename);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        stat.size !== descriptor.bytes
    )
        throw new Error('Invalid attachment ciphertext file');
    const stream = () =>
        createReadStream(filename, {
            fd: openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW),
            autoClose: true,
            highWaterMark: 64 * 1024,
        });
    const hash = createHash('sha256');
    for await (const chunk of stream()) hash.update(chunk);
    if (hash.digest('base64').replace(/=+$/, '') !== descriptor.file.hashes.sha256)
        throw new Error('Attachment recovery hash mismatch');
    let disposed = false;
    return {
        ...descriptor,
        stream() {
            if (disposed) throw new Error('Attachment already disposed');
            return stream();
        },
        async dispose() {
            disposed = true;
            await rm(directory, {recursive: true, force: true});
        },
    };
}

/** Remove a completed upload's spool, including after a crash before disposal. */
export async function discardAttachment(parent: string, spoolId: string): Promise<void> {
    if (!isAbsolute(parent) || !/^attachment-[A-Za-z0-9]{6}$/.test(spoolId))
        throw new Error('Invalid attachment spool');
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error('Attachment cleanup requires a private directory');
    await rm(join(parent, spoolId), {recursive: true, force: true});
}
