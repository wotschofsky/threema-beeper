import {MutationJournal} from './mutation-journal.ts';
import {MediaJournal} from './media-journal.ts';
import {createHash} from 'node:crypto';
import {ReactionJournal} from './reaction-journal.ts';
import {lstatSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';

interface RecoveryItem {
    id: string;
    event: string;
    room: string;
    chat: string;
    kind: 'text' | 'attachment';
    state: string;
    failures: number;
}
export interface TextRequest {
    requestId: string;
    profile: string;
    transactionId: string;
    eventId: string;
    roomId: string;
    sender: string;
    chatId: string;
    text: string;
    replyTo?: string;
}
export type OutboxState = 'PREPARED' | 'DISPATCHING' | 'SENT' | 'OUTCOME_UNKNOWN' | 'ACKED';
export interface OutboxRecord {
    request: TextRequest;
    state: OutboxState;
    ids: string[];
    retryAt: number;
    preflightFailures: number;
}
const messagePattern = /^m:[0-9a-f]{16}$/;
function validate(request: TextRequest): void {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            request.requestId,
        ) ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(request.profile) ||
        !/^(c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(request.chatId) ||
        typeof request.text !== 'string' ||
        request.text.length === 0 ||
        Buffer.byteLength(request.text) > 1024 * 1024 ||
        (request.replyTo !== undefined && !messagePattern.test(request.replyTo))
    )
        throw new Error('Invalid outbox request');
    for (const [value, prefix] of [
        [request.transactionId, ''],
        [request.eventId, '$'],
        [request.roomId, '!'],
        [request.sender, '@'],
    ])
        if (
            typeof value !== 'string' ||
            !value ||
            value.length > 1024 ||
            !value.startsWith(prefix!)
        )
            throw new Error('Invalid outbox event identity');
}
function validateIds(ids: readonly string[]): void {
    if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 1024 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !messagePattern.test(id))
    )
        throw new Error('Invalid allocated message IDs');
}

/** Encrypted request journal. One worker under exclusive profile ownership must dispatch it. */
export class OutboxStore {
    private readonly db: Database.Database;
    readonly reactions: ReactionJournal;
    readonly media: MediaJournal;
    readonly mutations: MutationJournal;
    constructor(filename: string, key: Buffer) {
        if (!isAbsolute(filename) || key.length !== 32) throw new Error('Invalid outbox options');
        const parent = lstatSync(dirname(filename));
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077)
            throw new Error('Outbox requires a private directory');
        try {
            const stat = lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid outbox file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.db = new Database(filename);
        this.reactions = new ReactionJournal(this.db);
        this.media = new MediaJournal(this.db);
        this.mutations = new MutationJournal(this.db);
        try {
            this.db.pragma('cipher_compatibility = 4');
            this.db.pragma(`key = "x'${key.toString('hex')}'"`);
            this.db.pragma('cipher_log_level = NONE');
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = FULL');
            this.db.pragma('foreign_keys = ON');
            const version = this.db.pragma('user_version', {simple: true});
            if (
                version !== 0 &&
                version !== 1 &&
                version !== 2 &&
                version !== 3 &&
                version !== 4 &&
                version !== 5 &&
                version !== 6 &&
                version !== 7 &&
                version !== 8 &&
                version !== 9 &&
                version !== 10 &&
                version !== 11 &&
                version !== 12 &&
                version !== 13 &&
                version !== 14 &&
                version !== 15 &&
                version !== 16 &&
                version !== 17
            )
                throw new Error('Unsupported outbox schema');
            this.db.transaction(() => {
                this.db.exec(`
                CREATE TABLE IF NOT EXISTS requests (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL, event TEXT NOT NULL,
                    digest TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
                    chat TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, preflight_failures INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHING','SENT','OUTCOME_UNKNOWN','ACKED')),
                    UNIQUE(profile,event)
                );
                CREATE TABLE IF NOT EXISTS rejections (
                    profile TEXT NOT NULL, event TEXT NOT NULL, room TEXT NOT NULL, reason TEXT NOT NULL,
                    PRIMARY KEY(profile,event)
                );
                CREATE TABLE IF NOT EXISTS parts (
                    request TEXT NOT NULL REFERENCES requests(id), profile TEXT NOT NULL,
                    message TEXT NOT NULL, part INTEGER NOT NULL, observed INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(request,part), UNIQUE(profile,message)
                );
            `);
                if (version === 1) {
                    this.db.exec(
                        'ALTER TABLE requests ADD COLUMN chat TEXT; ALTER TABLE requests ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE requests ADD COLUMN preflight_failures INTEGER NOT NULL DEFAULT 0;',
                    );
                    const update = this.db.prepare('UPDATE requests SET chat=? WHERE id=?');
                    const batch = this.db.prepare(
                        'SELECT sequence,id,body FROM requests WHERE sequence>? ORDER BY sequence LIMIT 16',
                    );
                    let cursor = 0;
                    while (true) {
                        const rows = batch.all(cursor) as {
                            sequence: number;
                            id: string;
                            body: string;
                        }[];
                        if (!rows.length) break;
                        for (const row of rows) {
                            const request = JSON.parse(row.body) as TextRequest;
                            validate(request);
                            update.run(request.chatId, row.id);
                            cursor = row.sequence;
                        }
                    }
                }
                this.db.exec(
                    'CREATE INDEX IF NOT EXISTS outbox_chat_sequence ON requests(profile,chat,sequence); CREATE INDEX IF NOT EXISTS outbox_profile_state ON requests(profile,state); PRAGMA user_version=17;',
                );
                ReactionJournal.migrate(this.db);
                MediaJournal.migrate(this.db);
                MutationJournal.migrate(this.db);
            })();
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    rejection(profile: string, event: string): {room: string; reason: string} | undefined {
        return this.db
            .prepare('SELECT room,reason FROM rejections WHERE profile=? AND event=?')
            .get(profile, event) as {room: string; reason: string} | undefined;
    }
    rejectEvent(profile: string, event: string, room: string, reason: string): void {
        if (this.mutations.get(profile, event))
            throw new Error('Mutation event cannot be rejected');
        if (this.media.get(profile, event)) throw new Error('Media event cannot be rejected');
        if (
            !/^[A-Z0-9*][A-Z0-9]{7}$/.test(profile) ||
            !event.startsWith('$') ||
            event.length > 1024 ||
            !room.startsWith('!') ||
            room.length > 1024 ||
            !reason ||
            reason.length > 1024
        )
            throw new Error('Invalid rejection record');
        this.db.transaction(() => {
            if (this.reactions.get(profile, event))
                throw new Error('Accepted reaction cannot be rejected');
            if (
                this.db
                    .prepare('SELECT 1 FROM requests WHERE profile=? AND event=?')
                    .get(profile, event)
            )
                throw new Error('Accepted event cannot be rejected');
            const existing = this.rejection(profile, event);
            if (existing && (existing.room !== room || existing.reason !== reason))
                throw new Error('Rejection conflict');
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO rejections(profile,event,room,reason) VALUES (?,?,?,?)',
                )
                .run(profile, event, room, reason);
        })();
    }
    /** Check the opened encrypted database connection; does not assert free disk space. */
    pendingCounts(profile: string): {
        prepared: number;
        dispatching: number;
        awaitingEcho: number;
        uncertain: number;
    } {
        const counts = {prepared: 0, dispatching: 0, awaitingEcho: 0, uncertain: 0};
        const rows = this.db
            .prepare(
                "SELECT state,count(*) AS count FROM requests WHERE profile=? AND state IN ('PREPARED','DISPATCHING','SENT','OUTCOME_UNKNOWN') GROUP BY state",
            )
            .all(profile) as {state: OutboxState; count: number}[];
        for (const row of rows) {
            if (row.state === 'PREPARED') counts.prepared = row.count;
            if (row.state === 'DISPATCHING') counts.dispatching = row.count;
            if (row.state === 'SENT') counts.awaitingEcho = row.count;
            if (row.state === 'OUTCOME_UNKNOWN') counts.uncertain = row.count;
        }
        return counts;
    }
    /** Local recovery lists omit message bodies, filenames and credentials. */
    recoveryItems(profile: string): RecoveryItem[] {
        return [
            ...this.recoveryPage(profile, 'text').items,
            ...this.recoveryPage(profile, 'attachment').items,
        ];
    }
    /** Sequence cursors let background notices visit a backlog without loading it all. */
    recoveryPage(
        profile: string,
        kind: 'text' | 'attachment',
        after = 0,
        limit = 100,
    ): {
        items: RecoveryItem[];
        next: number;
    } {
        if (
            !['text', 'attachment'].includes(kind) ||
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000
        )
            throw new Error('Invalid recovery page');
        const rows = this.db
            .prepare(
                kind === 'text'
                    ? "SELECT sequence,id,event,body,chat,state,preflight_failures AS failures FROM requests WHERE profile=? AND sequence>? AND state!='ACKED' ORDER BY sequence LIMIT ?"
                    : "SELECT sequence,id,event,body,chat,CASE WHEN EXISTS(SELECT 1 FROM media_replies q WHERE q.profile=media_requests.profile AND q.event=media_requests.event AND q.state='OUTCOME_UNKNOWN') THEN 'OUTCOME_UNKNOWN' ELSE state END AS state,preflight_failures AS failures FROM media_requests WHERE profile=? AND sequence>? AND (state!='SENT' OR EXISTS(SELECT 1 FROM media_parts WHERE request=media_requests.id AND observed=0) OR EXISTS(SELECT 1 FROM media_replies q WHERE q.profile=media_requests.profile AND q.event=media_requests.event AND q.state='OUTCOME_UNKNOWN')) ORDER BY sequence LIMIT ?",
            )
            .all(profile, after, limit) as {
            sequence: number;
            id: string;
            event: string;
            body: string;
            chat: string;
            state: string;
            failures: number;
        }[];
        return {
            items: rows.map((row) => ({
                id: row.id,
                event: row.event,
                room:
                    kind === 'text'
                        ? (JSON.parse(row.body) as TextRequest).roomId
                        : JSON.parse(row.body).room,
                chat: row.chat,
                kind,
                state: row.state,
                failures: row.failures,
            })),
            next: rows.length === limit ? rows.at(-1)!.sequence : 0,
        };
    }
    /** Only work which has never entered dispatch may be retried on demand. */
    retryPrepared(profile: string): number {
        return this.db.transaction(() => {
            const text = this.db
                .prepare(
                    "UPDATE requests SET retry_at=0 WHERE profile=? AND state='PREPARED' AND retry_at>0",
                )
                .run(profile).changes;
            const media = this.db
                .prepare(
                    "UPDATE media_requests SET retry_at=0 WHERE profile=? AND state='PREPARED' AND retry_at>0 AND NOT EXISTS(SELECT 1 FROM media_replies q WHERE q.profile=media_requests.profile AND q.event=media_requests.event AND q.state='OUTCOME_UNKNOWN')",
                )
                .run(profile).changes;
            return text + media;
        })();
    }
    checkHealth(): void {
        this.db.prepare('SELECT count(*) FROM sqlite_master').get();
    }
    close(): void {
        this.db.close();
    }
    prepare(input: TextRequest): OutboxRecord {
        validate(input);
        if (this.media.get(input.profile, input.eventId))
            throw new Error('Event is already a media operation');
        // Explicit projection drops unknown properties and fixes canonical field ordering.
        const request: TextRequest = {
            requestId: input.requestId,
            profile: input.profile,
            transactionId: input.transactionId,
            eventId: input.eventId,
            roomId: input.roomId,
            sender: input.sender,
            chatId: input.chatId,
            text: input.text,
            ...(input.replyTo === undefined ? {} : {replyTo: input.replyTo}),
        };
        const digest = createHash('sha256')
            .update(
                JSON.stringify([
                    request.profile,
                    request.eventId,
                    request.roomId,
                    request.sender,
                    request.chatId,
                    request.text,
                    request.replyTo ?? null,
                ]),
            )
            .digest('hex');
        return this.db.transaction(() => {
            if (this.mutations.get(request.profile, request.eventId))
                throw new Error('Event is already a mutation');
            if (this.reactions.get(request.profile, request.eventId))
                throw new Error('Event is already a reaction operation');
            if (this.rejection(request.profile, request.eventId))
                throw new Error('Rejected event cannot be sent');
            const byId = this.db
                .prepare('SELECT id,digest FROM requests WHERE id=?')
                .get(request.requestId) as {id: string; digest: string} | undefined;
            const byEvent = this.db
                .prepare('SELECT id,digest FROM requests WHERE profile=? AND event=?')
                .get(request.profile, request.eventId) as {id: string; digest: string} | undefined;
            if (
                (byId && byId.digest !== digest) ||
                (byEvent && byEvent.digest !== digest) ||
                (byId && byEvent && byId.id !== byEvent.id)
            )
                throw new Error('Outbox request conflict');
            if (byId || byEvent) return this.get((byId ?? byEvent)!.id)!;
            this.db
                .prepare(
                    "INSERT INTO requests(id,profile,event,digest,body,created,chat,state) VALUES(?,?,?,?,?,?,?,'PREPARED')",
                )
                .run(
                    request.requestId,
                    request.profile,
                    request.eventId,
                    digest,
                    JSON.stringify(request),
                    Date.now(),
                    request.chatId,
                );
            return this.get(request.requestId)!;
        })();
    }
    get(id: string): OutboxRecord | undefined {
        const row = this.db
            .prepare('SELECT body,state,retry_at,preflight_failures FROM requests WHERE id=?')
            .get(id) as
            | {body: string; state: OutboxState; retry_at: number; preflight_failures: number}
            | undefined;
        if (!row) return undefined;
        const request = JSON.parse(row.body) as TextRequest;
        validate(request);
        const ids = (
            this.db.prepare('SELECT message FROM parts WHERE request=? ORDER BY part').all(id) as {
                message: string;
            }[]
        ).map(({message}) => message);
        if (ids.length) validateIds(ids);
        return {
            request,
            state: row.state,
            ids,
            retryAt: row.retry_at,
            preflightFailures: row.preflight_failures,
        };
    }
    /** Repair legacy insertion order without changing requests, retry deadlines or attempted sends. */
    reorderPrepared(
        source: (event: string) => {transaction: number; event: number} | undefined,
    ): number {
        return this.db.transaction(() => {
            const rows = this.db
                .prepare(
                    "SELECT sequence,id,profile,chat,event FROM requests WHERE state='PREPARED' ORDER BY sequence",
                )
                .all() as {
                sequence: number;
                id: string;
                profile: string;
                chat: string;
                event: string;
            }[];
            const groups = new Map<string, typeof rows>();
            for (const row of rows) {
                const key = JSON.stringify([row.profile, row.chat]);
                const group = groups.get(key) ?? [];
                group.push(row);
                groups.set(key, group);
            }
            const update = this.db.prepare(
                "UPDATE requests SET sequence=? WHERE id=? AND state='PREPARED'",
            );
            let changed = 0;
            for (const group of groups.values()) {
                const positions = new Map(group.map((row) => [row.id, source(row.event)]));
                // Missing provenance is not permission to invent an order.
                if ([...positions.values()].some((position) => !position)) continue;
                const sorted = [...group].sort((a, b) => {
                    const x = positions.get(a.id)!,
                        y = positions.get(b.id)!;
                    return x.transaction - y.transaction || x.event - y.event;
                });
                const moves = sorted
                    .map((row, index) => ({row, sequence: group[index]!.sequence}))
                    .filter((move) => move.row.sequence !== move.sequence);
                // Negative slots avoid primary-key collisions; both phases commit atomically.
                for (const move of moves) update.run(-move.row.sequence, move.row.id);
                for (const move of moves) update.run(move.sequence, move.row.id);
                changed += moves.length;
            }
            return changed;
        })();
    }

    nextPrepared(now = Date.now()): OutboxRecord | undefined {
        if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid outbox time');
        const row = this.db
            .prepare(
                `SELECT current.id FROM requests current
            WHERE current.state='PREPARED' AND current.retry_at<=?
            AND NOT EXISTS (SELECT 1 FROM requests earlier WHERE earlier.profile=current.profile
                AND earlier.chat=current.chat AND earlier.sequence<current.sequence
                AND earlier.state IN ('PREPARED','DISPATCHING','OUTCOME_UNKNOWN'))
            ORDER BY current.sequence LIMIT 1`,
            )
            .get(now) as {id: string} | undefined;
        return row ? this.get(row.id) : undefined;
    }
    claim(expectedId?: string, now = Date.now()): OutboxRecord | undefined {
        return this.db.transaction(() => {
            const record = this.nextPrepared(now);
            if (!record || (expectedId !== undefined && record.request.requestId !== expectedId))
                return undefined;
            this.db
                .prepare("UPDATE requests SET state='DISPATCHING' WHERE id=?")
                .run(record.request.requestId);
            return this.get(record.request.requestId);
        })();
    }
    /** Retry only read-only preflight failures; never resets an uncertain dispatch. */
    deferPreflight(id: string, retryAt: number): void {
        if (!Number.isSafeInteger(retryAt) || retryAt < 0)
            throw new Error('Invalid retry deadline');
        this.db
            .prepare(
                "UPDATE requests SET retry_at=?,preflight_failures=MIN(preflight_failures+1,30) WHERE id=? AND state='PREPARED'",
            )
            .run(retryAt, id);
    }
    /** Local acceptance alone does not prove the native send task completed. Unconfirmed work becomes uncertain
     * at startup; only confirmed ACKED rows remain complete. Never makes a row sendable again. */
    recoverInterrupted(): void {
        this.mutations.recoverInterrupted();
        this.reactions.recoverInterrupted();
        this.media.recoverInterrupted();
        this.db
            .prepare(
                "UPDATE requests SET state='OUTCOME_UNKNOWN' WHERE state IN ('DISPATCHING','SENT')",
            )
            .run();
    }
    recordIds(id: string, ids: readonly string[]): void {
        validateIds(ids);
        this.db.transaction(() => {
            const record = this.get(id);
            if (!record || record.state !== 'DISPATCHING')
                throw new Error('Outbox allocation state conflict');
            if (record.ids.length) {
                if (JSON.stringify(record.ids) !== JSON.stringify(ids))
                    throw new Error('Outbox allocation conflict');
                return;
            }
            for (const message of ids) {
                if (
                    this.db
                        .prepare('SELECT 1 FROM media_parts WHERE profile=? AND message=?')
                        .get(record.request.profile, message)
                )
                    throw new Error('Outbound ID already belongs to media');
            }
            const insert = this.db.prepare(
                'INSERT INTO parts(request,profile,message,part) VALUES(?,?,?,?)',
            );
            ids.forEach((message, part) => insert.run(id, record.request.profile, message, part));
        })();
    }
    sent(id: string, ids: readonly string[]): void {
        validateIds(ids);
        this.db.transaction(() => {
            const record = this.get(id);
            if (
                !record ||
                !['DISPATCHING', 'ACKED'].includes(record.state) ||
                JSON.stringify(record.ids) !== JSON.stringify(ids)
            )
                throw new Error('Outbox send result conflict');
            if (record.state !== 'ACKED')
                this.db.prepare("UPDATE requests SET state='SENT' WHERE id=?").run(id);
        })();
    }
    unknown(id: string): void {
        this.db
            .prepare(
                "UPDATE requests SET state='OUTCOME_UNKNOWN' WHERE id=? AND state='DISPATCHING'",
            )
            .run(id);
    }
    forMessage(profile: string, message: string): OutboxRecord | undefined {
        const part = this.db
            .prepare('SELECT request FROM parts WHERE profile=? AND message=?')
            .get(profile, message) as {request: string} | undefined;
        return part ? this.get(part.request) : undefined;
    }
    forEvent(profile: string, event: string): OutboxRecord | undefined {
        const row = this.db
            .prepare('SELECT id FROM requests WHERE profile=? AND event=?')
            .get(profile, event) as {id: string} | undefined;
        return row ? this.get(row.id) : undefined;
    }
    /** Caller verifies an outbound canonical echo for this profile/chat before invoking. */
    observe(profile: string, chatId: string, message: string): OutboxRecord | undefined {
        if (!messagePattern.test(message)) throw new Error('Invalid echo message ID');
        return this.db.transaction(() => {
            const part = this.db
                .prepare('SELECT request FROM parts WHERE profile=? AND message=?')
                .get(profile, message) as {request: string} | undefined;
            if (!part) return undefined;
            const record = this.get(part.request)!;
            if (record.request.chatId !== chatId)
                throw new Error('Outbox echo conversation conflict');
            this.db
                .prepare('UPDATE parts SET observed=1 WHERE request=? AND message=?')
                .run(part.request, message);
            const pending = this.db
                .prepare('SELECT 1 FROM parts WHERE request=? AND observed=0 LIMIT 1')
                .get(part.request);
            if (!pending)
                this.db.prepare("UPDATE requests SET state='ACKED' WHERE id=?").run(part.request);
            return this.get(part.request);
        })();
    }
}
