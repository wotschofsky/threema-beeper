import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, statfs, unlink} from 'node:fs/promises';
import {join} from 'node:path';

export interface DiskState { schemaVersion: 1; revision: number; active: boolean }
export function parseDiskState(value: unknown): DiskState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid disk monitor state');
    const state = value as Record<string, unknown>;
    if (Object.keys(state).sort().join(',') !== 'active,revision,schemaVersion' || state.schemaVersion !== 1 ||
        !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || typeof state.active !== 'boolean' ||
        (state.active && state.revision === 0)) throw new Error('Invalid disk monitor state');
    return {schemaVersion: 1, revision: state.revision as number, active: state.active};
}
export async function readDiskState(directory: string): Promise<DiskState | undefined> {
    let file;
    try { file = await open(join(directory, 'state.json'), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
        const bytes = Buffer.alloc(1025);
        let length = 0;
        while (length < bytes.length) {
            const {bytesRead} = await file.read(bytes, length, bytes.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > 1024) throw new Error('Disk monitor state too large');
        return parseDiskState(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    } finally { await file.close(); }
}
export async function writeDiskState(directory: string, state: DiskState): Promise<void> {
    const bytes = JSON.stringify(parseDiskState(state)) + '\n';
    await mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(directory, 'state.json'));
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
}
export async function diskCapacity(directory: string): Promise<{blocks: bigint; available: bigint}> {
    const result = await statfs(directory, {bigint: true});
    return {blocks: result.blocks, available: result.bavail};
}

/** Single maintenance-pump writer under the service's exclusive profile ownership. */
export class DiskNotices {
    private state: DiskState;
    private sampledAt?: number;
    private readonly options: {
        owner: string; initial?: DiskState; now: () => number;
        sample: () => Promise<{blocks: bigint; available: bigint}>;
        persist: (state: DiskState) => Promise<void>;
        ready: () => boolean; delivered: (id: string) => boolean; authorize: () => Promise<string>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: DiskNotices['options']) {
        this.options = options;
        this.state = options.initial ? parseDiskState(options.initial) : {schemaVersion: 1, revision: 0, active: false};
    }
    async drain(): Promise<number> {
        const now = this.options.now();
        if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid disk monitor clock');
        if (this.sampledAt === undefined || now < this.sampledAt || now - this.sampledAt >= 60_000) {
            const {blocks, available} = await this.options.sample();
            if (blocks <= 0n || available < 0n || available > blocks) throw new Error('Invalid filesystem capacity');
            const next = {...this.state};
            if (!next.active && available * 5n <= blocks) {
                if (next.revision === Number.MAX_SAFE_INTEGER) throw new Error('Disk monitor revision exhausted');
                next.revision++; next.active = true;
            } else if (next.active && available * 4n > blocks) next.active = false;
            if (next.active !== this.state.active || next.revision !== this.state.revision) {
                await this.options.persist(next);
                this.state = next;
            }
            this.sampledAt = now;
        }
        if (!this.state.revision || !this.options.ready()) return 0;
        const id = 'disk_' + createHash('sha256').update(JSON.stringify([this.options.owner, this.state.revision])).digest('hex');
        if (this.options.delivered(id)) return 0;
        const room = await this.options.authorize();
        if (!this.options.ready()) return 0;
        await this.options.send(id, room, {msgtype: 'm.notice', body:
            'The filesystem holding Threema bridge data had 20% or less space available to the bridge. Free space or expand storage before it fills up. Check bridge status and backups; do not delete profile databases or message queues. Space may have recovered since this warning was recorded.'});
        return 1;
    }
}
