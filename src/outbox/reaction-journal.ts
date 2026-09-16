import type Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {parseReactionCommand} from '../threema/reaction-command.ts';

export interface ReactionOperation {
    profile: string;
    event: string;
    room: string;
    owner: string;
    chat: string;
    target: string;
    emoji: string;
    action: 'apply' | 'withdraw';
    messages: string[];
}
export interface ReactionCursor {
    sequence: number;
    part: number;
}
function validateCursor(cursor: ReactionCursor): void {
    if (
        !Number.isSafeInteger(cursor.sequence) ||
        cursor.sequence < 0 ||
        !Number.isInteger(cursor.part) ||
        cursor.part < -1 ||
        cursor.part > 1023
    )
        throw new Error('Invalid reaction cursor');
}
export type ReactionPartState =
    | 'PREPARED'
    | 'DISPATCHING'
    | 'SENT'
    | 'OUTCOME_UNKNOWN'
    | 'REJECTED';
function serialize(operation: ReactionOperation): string {
    if (
        !Array.isArray(operation.messages) ||
        operation.messages.length < 1 ||
        operation.messages.length > 1024 ||
        new Set(operation.messages).size !== operation.messages.length ||
        !/^\$[^\s]{1,1024}$/.test(operation.event) ||
        !/^\$[^\s]{1,1024}$/.test(operation.target) ||
        !/^![^\s]{1,1024}:[^\s]+$/.test(operation.room) ||
        !/^@[^\s]{1,1024}:[^\s]+$/.test(operation.owner)
    )
        throw new Error('Invalid reaction operation');
    for (const messageId of operation.messages)
        parseReactionCommand({
            profile: operation.profile,
            chatId: operation.chat,
            messageId,
            emoji: operation.emoji,
            action: operation.action,
        });
    return JSON.stringify({
        profile: operation.profile,
        event: operation.event,
        room: operation.room,
        owner: operation.owner,
        chat: operation.chat,
        target: operation.target,
        emoji: operation.emoji,
        action: operation.action,
        messages: operation.messages,
    });
}

/** Shares the encrypted outbox connection and its exclusive profile lock. */
export class ReactionJournal {
    private readonly db: Database.Database;
    constructor(db: Database.Database) {
        this.db = db;
    }
    static migrate(db: Database.Database): void {
        const old = db
            .prepare("SELECT sql FROM sqlite_master WHERE name='reaction_parts'")
            .get() as {sql: string} | undefined;
        if (old && !old.sql.includes("'REJECTED'"))
            db.exec('ALTER TABLE reaction_parts RENAME TO reaction_parts_v4');
        db.exec(`CREATE TABLE IF NOT EXISTS reaction_operations (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            profile TEXT NOT NULL, event TEXT NOT NULL, chat TEXT NOT NULL, body TEXT NOT NULL,
            UNIQUE(profile,event));
            CREATE TABLE IF NOT EXISTS reaction_parts (
                operation INTEGER NOT NULL REFERENCES reaction_operations(sequence),
                part INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHING','SENT','OUTCOME_UNKNOWN','REJECTED')),
                PRIMARY KEY(operation,part));
            CREATE INDEX IF NOT EXISTS reaction_chat_order ON reaction_operations(profile,chat,sequence);`);
        if (old && !old.sql.includes("'REJECTED'"))
            db.exec(
                'INSERT INTO reaction_parts SELECT * FROM reaction_parts_v4; DROP TABLE reaction_parts_v4;',
            );
        db.exec(`CREATE TABLE IF NOT EXISTS reaction_failures (
            operation INTEGER NOT NULL REFERENCES reaction_operations(sequence), part INTEGER NOT NULL,
            reason TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(operation,part));`);
        db.exec(`CREATE TABLE IF NOT EXISTS reaction_retirements (
            profile TEXT NOT NULL, event TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(profile,event));`);
    }
    prepare(operation: ReactionOperation): void {
        const body = serialize(operation);
        if (
            this.db
                .prepare('SELECT 1 FROM mutation_operations WHERE profile=? AND event=?')
                .get(operation.profile, operation.event)
        )
            throw new Error('Event is already a mutation');
        this.db.transaction(() => {
            if (
                this.db
                    .prepare('SELECT 1 FROM media_requests WHERE profile=? AND event=?')
                    .get(operation.profile, operation.event)
            )
                throw new Error('Reaction event is already media');
            if (
                this.db
                    .prepare('SELECT 1 FROM rejections WHERE profile=? AND event=?')
                    .get(operation.profile, operation.event) ||
                this.db
                    .prepare('SELECT 1 FROM requests WHERE profile=? AND event=?')
                    .get(operation.profile, operation.event)
            )
                throw new Error('Reaction event was already classified');
            const existing = this.db
                .prepare('SELECT body FROM reaction_operations WHERE profile=? AND event=?')
                .get(operation.profile, operation.event) as {body: string} | undefined;
            if (existing) {
                if (existing.body !== body) throw new Error('Reaction operation conflict');
                return;
            }
            const result = this.db
                .prepare(
                    'INSERT INTO reaction_operations(profile,event,chat,body) VALUES (?,?,?,?)',
                )
                .run(operation.profile, operation.event, operation.chat, body);
            const insert = this.db.prepare(
                "INSERT INTO reaction_parts(operation,part,state) VALUES (?,?,'PREPARED')",
            );
            operation.messages.forEach((_id, part) => insert.run(result.lastInsertRowid, part));
        })();
    }
    get(
        profile: string,
        event: string,
    ): {operation: ReactionOperation; states: ReactionPartState[]} | undefined {
        const row = this.db
            .prepare('SELECT sequence,body FROM reaction_operations WHERE profile=? AND event=?')
            .get(profile, event) as {sequence: number; body: string} | undefined;
        if (!row) return undefined;
        const operation = JSON.parse(row.body) as ReactionOperation;
        serialize(operation);
        const states = (
            this.db
                .prepare('SELECT state FROM reaction_parts WHERE operation=? ORDER BY part')
                .all(row.sequence) as {state: ReactionPartState}[]
        ).map((row) => row.state);
        return {operation, states};
    }
    /** Reorder only the wholly unattempted tail; attempted reference history is immutable. */
    reorderPrepared(
        source: (event: string) => {transaction: number; event: number} | undefined,
    ): number {
        if (this.db.inTransaction)
            throw new Error('Reaction ordering repair requires its own transaction');
        return this.db.transaction(() => {
            const rows = this.db
                .prepare(
                    `WITH attempted AS (
                        SELECT o.profile,o.chat,MAX(o.sequence) AS last_attempt
                        FROM reaction_operations o JOIN reaction_parts p ON p.operation=o.sequence
                        WHERE p.state!='PREPARED' GROUP BY o.profile,o.chat
                    )
                SELECT o.sequence,o.profile,o.chat,o.event FROM reaction_operations o
                LEFT JOIN attempted a ON a.profile=o.profile AND a.chat=o.chat
                WHERE o.sequence>COALESCE(a.last_attempt,0)
                ORDER BY o.sequence`,
                )
                .all() as {sequence: number; profile: string; chat: string; event: string}[];
            const groups = new Map<string, typeof rows>();
            for (const row of rows) {
                const key = JSON.stringify([row.profile, row.chat]);
                const group = groups.get(key) ?? [];
                group.push(row);
                groups.set(key, group);
            }
            const moves: {from: number; to: number}[] = [];
            for (const group of groups.values()) {
                const positions = new Map(group.map((row) => [row.event, source(row.event)]));
                if ([...positions.values()].some((position) => !position)) continue;
                const sorted = [...group].sort((a, b) => {
                    const x = positions.get(a.event)!,
                        y = positions.get(b.event)!;
                    return x.transaction - y.transaction || x.event - y.event;
                });
                sorted.forEach((row, index) => {
                    const to = group[index]!.sequence;
                    if (row.sequence !== to) moves.push({from: row.sequence, to});
                });
            }
            if (!moves.length) return 0;
            // Parent keys and all parts move in the same commit; SQLite verifies FKs at commit.
            this.db.pragma('defer_foreign_keys = ON');
            const parent = this.db.prepare(
                'UPDATE reaction_operations SET sequence=? WHERE sequence=?',
            );
            const parts = this.db.prepare(
                'UPDATE reaction_parts SET operation=? WHERE operation=?',
            );
            for (const {from} of moves) {
                parent.run(-from, from);
                parts.run(-from, from);
            }
            for (const {from, to} of moves) {
                parent.run(to, -from);
                parts.run(to, -from);
            }
            return moves.length;
        })();
    }

    private candidate(profile: string, excluded: readonly string[]) {
        if (excluded.length > 1000) throw new Error('Reaction exclusion limit exceeded');
        return this.db
            .prepare(
                `SELECT o.sequence,o.body,p.part FROM reaction_operations o
                JOIN reaction_parts p ON p.operation=o.sequence
                WHERE o.profile=? AND p.state='PREPARED'
                ${excluded.length ? `AND o.chat NOT IN (${excluded.map(() => '?').join(',')})` : ''}
                AND NOT EXISTS (SELECT 1 FROM reaction_operations prior JOIN reaction_parts q ON q.operation=prior.sequence
                    WHERE prior.profile=o.profile AND prior.chat=o.chat AND q.state NOT IN ('SENT','REJECTED')
                    AND (prior.sequence<o.sequence OR (prior.sequence=o.sequence AND q.part<p.part)))
                ORDER BY o.sequence,p.part LIMIT 1`,
            )
            .get(profile, ...excluded) as
            | {sequence: number; body: string; part: number}
            | undefined;
    }
    next(
        profile: string,
        excluded: readonly string[] = [],
    ): {operation: ReactionOperation; part: number} | undefined {
        const row = this.candidate(profile, excluded);
        if (!row) return undefined;
        const operation = JSON.parse(row.body) as ReactionOperation;
        serialize(operation);
        return {operation, part: row.part};
    }
    claim(
        profile: string,
        expected?: {event: string; part: number},
        excluded: readonly string[] = [],
    ): {operation: ReactionOperation; part: number} | undefined {
        return this.db.transaction(() => {
            const row = this.candidate(profile, excluded);
            if (!row) return undefined;
            const operation = JSON.parse(row.body) as ReactionOperation;
            serialize(operation);
            if (expected && (expected.event !== operation.event || expected.part !== row.part))
                return undefined;
            this.db
                .prepare(
                    "UPDATE reaction_parts SET state='DISPATCHING' WHERE operation=? AND part=? AND state='PREPARED'",
                )
                .run(row.sequence, row.part);
            return {operation, part: row.part};
        })();
    }
    finish(profile: string, event: string, part: number, state: 'SENT' | 'OUTCOME_UNKNOWN'): void {
        if (!Number.isSafeInteger(part) || part < 0 || !['SENT', 'OUTCOME_UNKNOWN'].includes(state))
            throw new Error('Invalid reaction completion');
        const result = this.db
            .prepare(
                `UPDATE reaction_parts SET state=? WHERE operation=(SELECT sequence FROM reaction_operations WHERE profile=? AND event=?)
            AND part=? AND state='DISPATCHING'`,
            )
            .run(state, profile, event, part);
        if (result.changes !== 1) throw new Error('Reaction part is not dispatching');
    }
    /** Compare active Matrix references before/after this operation, excluding later commands. */
    requiresRemoteMutation(profile: string, event: string, part: number): boolean {
        const current = this.get(profile, event);
        if (
            !current ||
            !Number.isSafeInteger(part) ||
            part < 0 ||
            current.states[part] !== 'DISPATCHING' ||
            !current.operation.messages[part]
        )
            throw new Error('Reaction part is not dispatching');
        const operation = current.operation;
        const message = operation.messages[part]!;
        const active = new Set<string>();
        const rows = this.db
            .prepare(
                `SELECT body FROM reaction_operations WHERE profile=? AND chat=?
            AND sequence <= (SELECT sequence FROM reaction_operations WHERE profile=? AND event=?)
            ORDER BY sequence`,
            )
            .iterate(profile, operation.chat, profile, event) as Iterable<{body: string}>;
        for (const row of rows) {
            const previous = JSON.parse(row.body) as ReactionOperation;
            if (this.retirement(profile, previous.event)) continue;
            const priorPart = previous.messages.indexOf(message);
            if (
                priorPart >= 0 &&
                this.get(profile, previous.event)?.states[priorPart] === 'REJECTED'
            )
                continue;
            if (
                previous.owner !== operation.owner ||
                previous.room !== operation.room ||
                previous.emoji !== operation.emoji ||
                !previous.messages.includes(message)
            )
                continue;
            const before = active.size > 0;
            if (previous.action === 'apply') active.add(previous.event);
            else active.delete(previous.target);
            if (previous.event === event) return before !== active.size > 0;
        }
        throw new Error('Reaction reference history is incomplete');
    }
    recoverInterrupted(): void {
        this.db
            .prepare("UPDATE reaction_parts SET state='OUTCOME_UNKNOWN' WHERE state='DISPATCHING'")
            .run();
    }
    reject(profile: string, event: string, part: number, reason: string): void {
        if (
            !['reaction-invalid', 'reaction-permission-denied', 'reaction-not-found'].includes(
                reason,
            )
        )
            throw new Error('Invalid reaction rejection');
        this.db.transaction(() => {
            const result = this.db
                .prepare(
                    `UPDATE reaction_parts SET state='REJECTED'
                WHERE operation=(SELECT sequence FROM reaction_operations WHERE profile=? AND event=?)
                AND part=? AND state='DISPATCHING'`,
                )
                .run(profile, event, part);
            if (result.changes !== 1) throw new Error('Reaction part is not dispatching');
            this.db
                .prepare(
                    `INSERT INTO reaction_failures(operation,part,reason)
                SELECT sequence,?,? FROM reaction_operations WHERE profile=? AND event=?`,
                )
                .run(part, reason, profile, event);
        })();
    }
    pendingFailures(
        profile: string,
        limit = 100,
        after: ReactionCursor = {sequence: 0, part: -1},
    ): {sequence: number; operation: ReactionOperation; part: number; reason: string}[] {
        validateCursor(after);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid reaction failure batch');
        const rows = this.db
            .prepare(
                `SELECT o.sequence,o.body,f.part,f.reason FROM reaction_failures f
            JOIN reaction_operations o ON o.sequence=f.operation
            WHERE o.profile=? AND f.notified=0 AND (o.sequence>? OR (o.sequence=? AND f.part>?)) ORDER BY o.sequence,f.part LIMIT ?`,
            )
            .all(profile, after.sequence, after.sequence, after.part, limit) as {
            sequence: number;
            body: string;
            part: number;
            reason: string;
        }[];
        return rows.map((row) => {
            const operation = JSON.parse(row.body) as ReactionOperation;
            serialize(operation);
            return {sequence: row.sequence, operation, part: row.part, reason: row.reason};
        });
    }
    acknowledgeFailure(profile: string, event: string, part: number): void {
        const result = this.db
            .prepare(
                `UPDATE reaction_failures SET notified=1
            WHERE operation=(SELECT sequence FROM reaction_operations WHERE profile=? AND event=?) AND part=?`,
            )
            .run(profile, event, part);
        if (result.changes !== 1) throw new Error('Unknown reaction failure');
    }
    uncertain(
        profile: string,
        limit = 100,
        after: ReactionCursor = {sequence: 0, part: -1},
    ): {sequence: number; operation: ReactionOperation; part: number}[] {
        validateCursor(after);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('Invalid reaction recovery batch');
        const rows = this.db
            .prepare(
                `SELECT o.sequence,o.body,p.part FROM reaction_operations o
            JOIN reaction_parts p ON p.operation=o.sequence WHERE o.profile=? AND p.state='OUTCOME_UNKNOWN'
            AND (o.sequence>? OR (o.sequence=? AND p.part>?)) ORDER BY o.sequence,p.part LIMIT ?`,
            )
            .all(profile, after.sequence, after.sequence, after.part, limit) as {
            sequence: number;
            body: string;
            part: number;
        }[];
        return rows.map((row) => {
            const operation = JSON.parse(row.body) as ReactionOperation;
            serialize(operation);
            return {sequence: row.sequence, operation, part: row.part};
        });
    }
    observeDesiredState(profile: string, event: string, part: number, present: boolean): boolean {
        const record = this.get(profile, event);
        if (
            !record ||
            !Number.isInteger(part) ||
            part < 0 ||
            record.states[part] !== 'OUTCOME_UNKNOWN' ||
            typeof present !== 'boolean'
        )
            throw new Error('Invalid reaction recovery observation');
        if (present !== (record.operation.action === 'apply')) return false;
        this.db
            .prepare(
                `UPDATE reaction_parts SET state='SENT' WHERE operation=(SELECT sequence FROM reaction_operations WHERE profile=? AND event=?)
            AND part=? AND state='OUTCOME_UNKNOWN'`,
            )
            .run(profile, event, part);
        return true;
    }
    /** Matrix source references still visible for this message; withdrawals remove their source reference. */
    activeReferences(profile: string, chat: string, message: string): Map<string, string[]> {
        const active = new Map<string, {emoji: string; event: string}>();
        const rows = this.db
            .prepare(
                'SELECT body FROM reaction_operations WHERE profile=? AND chat=? ORDER BY sequence',
            )
            .iterate(profile, chat) as Iterable<{body: string}>;
        for (const row of rows) {
            const operation = JSON.parse(row.body) as ReactionOperation;
            if (this.retirement(profile, operation.event)) continue;
            const part = operation.messages.indexOf(message);
            if (part < 0) continue;
            if (operation.action === 'withdraw') active.delete(operation.target);
            else if (this.get(profile, operation.event)?.states[part] !== 'REJECTED')
                active.set(operation.event, {emoji: operation.emoji, event: operation.event});
        }
        const byEmoji = new Map<string, string[]>();
        for (const {emoji, event} of active.values())
            byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), event]);
        return byEmoji;
    }
    pendingCounts(profile: string): {
        prepared: number;
        dispatching: number;
        uncertain: number;
        failureNotices: number;
        retirements: number;
    } {
        return this.db
            .prepare(
                `SELECT
            (SELECT count(*) FROM reaction_parts p JOIN reaction_operations o ON o.sequence=p.operation WHERE o.profile=@profile AND p.state='PREPARED') AS prepared,
            (SELECT count(*) FROM reaction_parts p JOIN reaction_operations o ON o.sequence=p.operation WHERE o.profile=@profile AND p.state='DISPATCHING') AS dispatching,
            (SELECT count(*) FROM reaction_parts p JOIN reaction_operations o ON o.sequence=p.operation WHERE o.profile=@profile AND p.state='OUTCOME_UNKNOWN') AS uncertain,
            (SELECT count(*) FROM reaction_failures f JOIN reaction_operations o ON o.sequence=f.operation WHERE o.profile=@profile AND f.notified=0) AS failureNotices,
            (SELECT count(*) FROM reaction_retirements WHERE profile=@profile AND done=0) AS retirements
        `,
            )
            .get({profile}) as {
            prepared: number;
            dispatching: number;
            uncertain: number;
            failureNotices: number;
            retirements: number;
        };
    }
    retirement(profile: string, event: string): {done: boolean} | undefined {
        const row = this.db
            .prepare('SELECT done FROM reaction_retirements WHERE profile=? AND event=?')
            .get(profile, event) as {done: number} | undefined;
        return row ? {done: row.done === 1} : undefined;
    }
    retirementCandidates(
        profile: string,
        after: number,
        limit: number,
    ): {sequence: number; event: string}[] {
        if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 1000
        )
            throw new Error('Invalid retirement page');
        return this.db
            .prepare(
                `SELECT o.sequence,o.event FROM reaction_operations o
            LEFT JOIN reaction_retirements r ON r.profile=o.profile AND r.event=o.event
            WHERE o.profile=? AND o.sequence>? AND (r.done IS NULL OR r.done=0)
            ORDER BY o.sequence LIMIT ?`,
            )
            .all(profile, after, limit) as {sequence: number; event: string}[];
    }
    planRetirement(profile: string, event: string): void {
        this.db.transaction(() => {
            const record = this.get(profile, event);
            if (
                !record ||
                record.operation.action !== 'apply' ||
                record.states.some((state) => state !== 'SENT')
            )
                throw new Error('Reaction is not settled');
            if (this.chatPending(profile, record.operation.chat))
                throw new Error('Reaction chat has pending work');
            this.db
                .prepare('INSERT OR IGNORE INTO reaction_retirements(profile,event) VALUES (?,?)')
                .run(profile, event);
        })();
    }
    chatPending(profile: string, chat: string): boolean {
        return !!this.db
            .prepare(
                `SELECT 1 FROM reaction_operations o JOIN reaction_parts p ON p.operation=o.sequence
            WHERE o.profile=? AND o.chat=? AND p.state NOT IN ('SENT','REJECTED') LIMIT 1`,
            )
            .get(profile, chat);
    }
    finishRetirement(profile: string, event: string): void {
        if (
            this.db
                .prepare('UPDATE reaction_retirements SET done=1 WHERE profile=? AND event=?')
                .run(profile, event).changes !== 1
        )
            throw new Error('Unknown reaction retirement');
    }
}
