import {constants} from 'node:fs';
import {open, lstat, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, isAbsolute, normalize} from 'node:path';

/** Recheck a host-supplied, checksum-pinned executable without executing it. */
export async function verifyExecutable(
    filename: string,
    sha256: string,
    signal?: AbortSignal,
): Promise<void> {
    let file;
    const buffer = Buffer.alloc(65536);
    try {
        if (
            !isAbsolute(filename) ||
            normalize(filename) !== filename ||
            !/^[0-9a-f]{64}$/.test(sha256)
        )
            throw new Error();
        signal?.throwIfAborted();
        if ((await realpath(filename)) !== filename) throw new Error();
        // Other users must not be able to replace the executable through a writable ancestor.
        for (let parent = dirname(filename); ; parent = dirname(parent)) {
            const stat = await lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022)
                throw new Error();
            if (parent === dirname(parent)) break;
        }
        file = await open(
            filename,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const before = await file.stat();
        if (
            !before.isFile() ||
            before.mode & 0o022 ||
            !(before.mode & 0o111) ||
            before.size < 1 ||
            before.size > 256 * 1024 * 1024 ||
            (process.getuid && before.uid !== 0 && before.uid !== process.getuid())
        )
            throw new Error();
        const hash = createHash('sha256');
        let count = 0;
        while (true) {
            signal?.throwIfAborted();
            const {bytesRead} = await file.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            count += bytesRead;
            if (count > before.size) throw new Error();
            hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        const current = await lstat(filename);
        if (
            count !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            current.isSymbolicLink() ||
            hash.digest('hex') !== sha256
        )
            throw new Error();
        signal?.throwIfAborted();
    } catch {
        throw new Error('Executable verification failed');
    } finally {
        buffer.fill(0);
        await file?.close();
    }
}
