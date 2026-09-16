import {mkdir, open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseReconnectState, type ReconnectState} from './reconnect-policy.ts';

export async function readReconnectState(directory: string): Promise<ReconnectState | undefined> {
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
            const {bytesRead} = await file.read(bytes, length, bytes.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > 2048) throw new Error('Reconnect state too large');
        return parseReconnectState(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    } finally { await file.close(); }
}

/** Single maintenance-pump writer under the service's existing exclusive profile ownership. */
export async function writeReconnectState(directory: string, state: ReconnectState): Promise<void> {
    const bytes = JSON.stringify(parseReconnectState(state)) + '\n';
    await mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(directory, 'state.json'));
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
}
