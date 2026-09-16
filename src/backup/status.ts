import {randomUUID} from 'node:crypto';
import {mkdir, open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';

export interface BackupStatus {
    schemaVersion: 1;
    lastResult: 'success' | 'failed';
    incident?: string;
}

export function parseBackupStatus(value: unknown): BackupStatus {
    const state = value as BackupStatus;
    if (!state || state.schemaVersion !== 1 || !['success', 'failed'].includes(state.lastResult)
        || (state.incident !== undefined && (typeof state.incident !== 'string'
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(state.incident)))
        || (state.lastResult === 'failed' && !state.incident)) {
        throw new Error('Invalid backup status');
    }
    return {schemaVersion: 1, lastResult: state.lastResult, ...(state.incident ? {incident: state.incident} : {})};
}

export async function readBackupStatus(directory: string): Promise<BackupStatus | undefined> {
    let file;
    try { file = await open(join(directory, 'state.json'), 'r'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        const bytes = Buffer.alloc(2049);
        let length = 0;
        while (length < bytes.length) {
            const result = await file.read(bytes, length, bytes.length - length, null);
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        if (length > 2048) throw new Error('Backup status too large');
        return parseBackupStatus(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    } finally { await file.close(); }
}

/** The host backup flock serializes writers; no linked profile is opened here. */
export async function recordBackupStatus(directory: string, result: BackupStatus['lastResult']): Promise<void> {
    if (result !== 'success' && result !== 'failed') throw new Error('Invalid backup result');
    await mkdir(directory, {recursive: true, mode: 0o700});
    const previous = await readBackupStatus(directory);
    // Keep an undelivered incident after recovery. A later failure starts a new incident.
    const incident = result === 'failed' && previous?.lastResult !== 'failed'
        ? randomUUID() : previous?.incident;
    const next = parseBackupStatus({schemaVersion: 1, lastResult: result, incident});
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next) + '\n'); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(directory, 'state.json'));
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
}
