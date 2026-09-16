import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {connectionIssues, parseConnectionIssue, type ConnectionIssue} from '../../integrations/threema/overlay/src/headless/node-connection-issue.ts';

type State = {schemaVersion: 1; issues: Partial<Record<ConnectionIssue, {revision: number; active: boolean}>>};
function parse(value: unknown): State {
    const state = value as State;
    if (!state || state.schemaVersion !== 1 || !state.issues || typeof state.issues !== 'object' || Array.isArray(state.issues))
        throw new Error('Invalid connection issue state');
    const issues: State['issues'] = {};
    for (const [key, entry] of Object.entries(state.issues)) {
        if (!parseConnectionIssue(key) || !entry || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || typeof entry.active !== 'boolean')
            throw new Error('Invalid connection issue state');
        issues[key as ConnectionIssue] = {revision: entry.revision, active: entry.active};
    }
    return {schemaVersion: 1, issues};
}

/** Single service owner; coalesced writes preserve failures for retry without an unbounded event queue. */
export class ConnectionIssueJournal {
    private readonly directory: string;
    private state: State;
    private committed: State;
    private saved: string;
    private writing?: Promise<void>;
    private constructor(directory: string, state: State) {
        this.directory = directory; this.state = state; this.committed = parse(state); this.saved = JSON.stringify(state);
    }
    static async load(directory: string): Promise<ConnectionIssueJournal> {
        let state: State = {schemaVersion: 1, issues: {}};
        let file;
        try { file = await open(join(directory, 'state.json'), 'r'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (file) {
            try {
                const bytes = Buffer.alloc(4097); let length = 0;
                while (length < bytes.length) {
                    const {bytesRead} = await file.read(bytes, length, bytes.length - length, null);
                    if (!bytesRead) break; length += bytesRead;
                }
                if (length > 4096) throw new Error('Connection issue state too large');
                state = parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
            } finally { await file.close(); }
        }
        return new ConnectionIssueJournal(directory, state);
    }
    snapshot(): State { return parse(this.committed); }
    record(value: unknown): void {
        const issue = parseConnectionIssue(value);
        if (!issue) return;
        const previous = this.state.issues[issue];
        if (previous?.active) return;
        const revision = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('Connection issue revision exhausted');
        this.state.issues[issue] = {revision, active: true};
        void this.flush().catch(() => undefined);
    }
    recovered(): void {
        for (const entry of Object.values(this.state.issues)) entry.active = false;
        void this.flush().catch(() => undefined);
    }
    flush(): Promise<void> {
        if (this.writing) return this.writing;
        this.writing = this.save().finally(() => { this.writing = undefined; });
        return this.writing;
    }
    private async save(): Promise<void> {
        for (;;) {
            const bytes = JSON.stringify(this.state);
            if (bytes === this.saved) return;
            await mkdir(this.directory, {recursive: true, mode: 0o700});
            const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(bytes + '\n'); await file.sync(); }
                finally { await file.close(); }
                await rename(temporary, join(this.directory, 'state.json'));
                const parent = await open(this.directory, 'r');
                try { await parent.sync(); } finally { await parent.close(); }
                this.saved = bytes;
                this.committed = parse(JSON.parse(bytes));
            } finally { await unlink(temporary).catch(() => undefined); }
        }
    }
}
const advice: Record<ConnectionIssue, string> = {
    'client-update-required': 'Threema requires a newer linked-client protocol. Review the bridge and Threema Desktop compatibility update before restarting.',
    'mediator-update-required': 'The Threema server and linked client could not agree on a protocol version. Check service availability and the pinned client compatibility before retrying.',
    'client-was-dropped': 'This Threema linked device was removed. Check linked devices on your phone and use local recovery guidance.',
    'device-slot-state-mismatch': 'The Threema linked-device slot state does not match this profile. Check linked devices on your phone and use local recovery guidance.',
    'device-protocols-incompatible': 'Your Threema devices use incompatible protocol versions. Review app and bridge compatibility updates.',
};
export class ConnectionIssueNotices {
    private readonly options: {
        owner: string; journal: ConnectionIssueJournal; ready: () => boolean;
        delivered: (id: string) => boolean; authorize: () => Promise<string>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: ConnectionIssueNotices['options']) { this.options = options; }
    async drain(): Promise<number> {
        await this.options.journal.flush();
        const state = this.options.journal.snapshot();
        let count = 0;
        for (const issue of connectionIssues) {
            const entry = state.issues[issue];
            if (!entry || !this.options.ready()) continue;
            const id = 'connection_issue_' + createHash('sha256').update(JSON.stringify([this.options.owner, issue, entry.revision])).digest('hex');
            if (this.options.delivered(id)) continue;
            const room = await this.options.authorize();
            if (!this.options.ready()) break;
            await this.options.send(id, room, {msgtype: 'm.notice', body: advice[issue] + ' This may have recovered since the warning was recorded. No automatic update, relinking or profile reset was performed.'});
            count++;
        }
        return count;
    }
}
