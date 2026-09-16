import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

/** A ping URL commonly contains a bearer secret. Never include it in diagnostics. */
export function heartbeatUrl(value: string): URL {
    if (value.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(value))
        throw new Error('Invalid heartbeat configuration');
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Invalid heartbeat configuration'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
        throw new Error('Invalid heartbeat configuration');
    return url;
}

export async function readHeartbeatUrl(filename: string): Promise<URL> {
    if (!isAbsolute(filename) || await realpath(filename) !== filename)
        throw new Error('Invalid heartbeat configuration');
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 4097 ||
            (process.getuid && stat.uid !== process.getuid()))
            throw new Error('Invalid heartbeat configuration');
        const bytes = Buffer.alloc(4098);
        try {
            let length = 0;
            while (length < bytes.length) {
                const {bytesRead} = await file.read(bytes, length, bytes.length - length, null);
                if (!bytesRead) break;
                length += bytesRead;
            }
            if (length > 4097) throw new Error('Invalid heartbeat configuration');
            return heartbeatUrl(bytes.subarray(0, length).toString('utf8').trim());
        } finally { bytes.fill(0); }
    } finally { await file.close(); }
}

export type HeartbeatResult = 'sent' | 'unhealthy' | 'check-failed' | 'ping-failed';

/** Send only after a fresh readiness check; no retries or success ping on failure. */
export async function heartbeat(
    url: URL,
    check: () => Promise<{healthy: boolean}>,
    request: typeof fetch = fetch,
): Promise<HeartbeatResult> {
    // Revalidate callers' URL objects as well as private-file input.
    const destination = heartbeatUrl(url.href);
    try {
        if ((await check()).healthy !== true) return 'unhealthy';
    } catch { return 'check-failed'; }
    try {
        const response = await request(destination, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
            cache: 'no-store', credentials: 'omit',
        });
        await response.body?.cancel();
        return response.ok ? 'sent' : 'ping-failed';
    } catch { return 'ping-failed'; }
}
