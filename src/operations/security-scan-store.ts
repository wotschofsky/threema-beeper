import {mkdir, open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProfileLock} from '../threema/profile-lock.ts';
import {advanceSecurityScan, parseSecurityScanState, type SecurityScan, type SecurityScanState} from './security-scan.ts';

const maximumStateBytes = 16 * 1024 * 1024;
export async function readSecurityScanState(directory: string): Promise<SecurityScanState | undefined> {
    let file;
    try { file = await open(join(directory, 'state.json'), 'r'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        const chunks: Buffer[] = [];
        let length = 0;
        for (;;) {
            const chunk = Buffer.alloc(Math.min(65536, maximumStateBytes + 1 - length));
            const {bytesRead} = await file.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            length += bytesRead;
            if (length > maximumStateBytes) throw new Error('Scan state too large');
            chunks.push(chunk.subarray(0, bytesRead));
        }
        return parseSecurityScanState(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally { await file.close(); }
}

/** Separate OS-backed coordination lock; never opens the linked account profile. */
export async function recordSecurityScan(directory: string, scan?: SecurityScan): Promise<SecurityScanState> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const lock = new ProfileLock(join(directory, 'coordination'));
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try {
        const next = advanceSecurityScan(await readSecurityScanState(directory), scan);
        const bytes = JSON.stringify(next) + '\n';
        if (Buffer.byteLength(bytes) > maximumStateBytes) throw new Error('Scan state too large');
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(directory, 'state.json'));
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
        return next;
    } finally {
        await unlink(temporary).catch(() => undefined);
        lock.close();
    }
}
