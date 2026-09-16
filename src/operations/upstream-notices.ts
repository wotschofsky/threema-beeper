import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {parseUpstreamState, upstreamSources, type UpstreamState} from './upstream-monitor.ts';

export async function readUpstreamState(path: string): Promise<UpstreamState | undefined> {
    let file;
    try { file = await open(path, 'r'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        const buffer = Buffer.alloc(8193);
        let length = 0;
        while (length < buffer.length) {
            const {bytesRead} = await file.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > 8192) throw new Error('Upstream state too large');
        return parseUpstreamState(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    } finally { await file.close(); }
}

/** EncryptedSender persists ciphertext and acknowledgements under the supplied stable ID. */
export class UpstreamNotices {
    private readonly options: {
        owner: string;
        ready: () => boolean;
        load: () => Promise<UpstreamState | undefined>;
        delivered: (id: string) => boolean;
        authorize: () => Promise<string>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: UpstreamNotices['options']) { this.options = options; }

    async drain(): Promise<number> {
        if (!this.options.ready()) return 0;
        const loaded = await this.options.load();
        if (!loaded) return 0;
        const state = parseUpstreamState(loaded);
        let count = 0;
        for (const source of Object.keys(upstreamSources) as (keyof typeof upstreamSources)[]) {
            const pending = state.pending[source];
            if (!pending) continue;
            const id = 'upstream_' + createHash('sha256').update(JSON.stringify([
                this.options.owner, source, pending, state.revisions?.[source] ?? 0, state.snapshots[source] ?? null,
            ])).digest('hex');
            if (this.options.delivered(id)) continue;
            if (!this.options.ready()) break;
            const room = await this.options.authorize();
            if (!this.options.ready()) break;
            const label = {tags: 'Threema Desktop releases', changelog: 'Threema Desktop changelog', terms: 'Threema Terms page'}[source];
            const body = pending === 'changed'
                ? `${label} changed. Please review ${upstreamSources[source]}. No update has been installed automatically.`
                : `${label} could not be checked. Please check the weekly monitor and network access. Last successful results were preserved.`;
            await this.options.send(id, room, {msgtype: 'm.notice', body});
            count++;
        }
        return count;
    }
}
