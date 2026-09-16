import {lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {Readable} from 'node:stream';
import {create} from '../../node_modules/tar/dist/esm/index.js';
import {captureSnapshot} from './snapshot.ts';
import {encryptArchive} from './archive-crypto.ts';
import type {ServiceConfig} from '../service/config.ts';

/** Capture, archive and encrypt a closed profile. Never start or stop a running service. */
export async function createBackup(
    config: ServiceConfig,
    destination: string,
    backupKey: Buffer,
): Promise<void> {
    const parent = dirname(destination);
    const stat = await lstat(parent);
    if (
        !stat.isDirectory() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await realpath(parent)) !== parent
    )
        throw new Error('Backup requires private owned destination directory');
    const staging = await mkdtemp(join(parent, '.backup-stage-'));
    try {
        const snapshot = join(staging, 'snapshot');
        await captureSnapshot(config, snapshot);
        const archive = create({cwd: snapshot, portable: true, noMtime: true, strict: true}, [
            'manifest.json',
            'profile',
            'bridge',
            'secrets',
        ]);
        await encryptArchive(
            Readable.from(archive as unknown as AsyncIterable<Buffer>),
            destination,
            backupKey,
        );
    } catch {
        throw new Error('Closed-profile backup failed');
    } finally {
        await rm(staging, {recursive: true, force: true});
    }
}
