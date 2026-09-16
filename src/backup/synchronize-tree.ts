import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export async function synchronizePath(path: string): Promise<void> {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Private, exclusively owned staging tree: persist children before parent entries. */
export async function synchronizeTree(root: string): Promise<void> {
    const stat = await lstat(root);
    if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
    )
        throw new Error('Cannot synchronize unsafe restore tree');
    if (stat.isDirectory()) {
        for (const child of await readdir(root)) await synchronizeTree(join(root, child));
    }
    await synchronizePath(root);
}
