import {constants} from 'node:fs';
import {lstat, open, readdir, realpath, unlink} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

const archiveName = /^bridge-\d{8}T\d{6}Z\.enc$/u;
/** Called under the host backup lock, only after a newly published backup succeeds. */
export async function retainBackups(directory: string, newest: string, keep: number): Promise<number> {
    if (!isAbsolute(directory) || !archiveName.test(newest) || !Number.isSafeInteger(keep) || keep < 2 || keep > 3650)
        throw new Error('Invalid backup retention policy');
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.mode & 0o077 ||
        (process.getuid && parent.uid !== process.getuid()) || await realpath(directory) !== directory)
        throw new Error('Retention requires a private owned directory');
    const candidates: {name: string; ino: number; dev: number; size: number; mtimeMs: number}[] = [];
    for (const name of await readdir(directory)) {
        if (!archiveName.test(name)) continue;
        const path = join(directory, name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 ||
            stat.uid !== parent.uid || stat.size < 36) continue;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const current = await file.stat();
            if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Backup changed during retention');
            const magic = Buffer.alloc(8);
            const {bytesRead} = await file.read(magic, 0, 8, 0);
            if (bytesRead !== 8 || magic.toString('ascii') !== 'TBBKUP01') continue;
            candidates.push({name, ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs});
        } finally { await file.close(); }
    }
    candidates.sort((a, b) => b.name.localeCompare(a.name, 'en'));
    if (candidates[0]?.name !== newest) throw new Error('Newest completed backup must be retained');
    const preserved = candidates.slice(0, keep);
    let removed = 0;
    for (const candidate of candidates.slice(keep)) {
        // Detect concurrent removal/replacement of retained backups before deleting anything else.
        for (const record of [...preserved, candidate]) {
            const current = await lstat(join(directory, record.name));
            if (!current.isFile() || current.ino !== record.ino || current.dev !== record.dev ||
                current.size !== record.size || current.mtimeMs !== record.mtimeMs || current.nlink !== 1)
                throw new Error('Backup changed during retention');
        }
        const currentParent = await lstat(directory);
        if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev || await realpath(directory) !== directory)
            throw new Error('Backup directory changed during retention');
        await unlink(join(directory, candidate.name));
        removed++;
    }
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    return removed;
}
