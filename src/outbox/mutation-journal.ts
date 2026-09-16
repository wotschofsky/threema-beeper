import type Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {parseMutationCommand, type NodeMutationRequest} from '../threema/mutation-command.ts';

export interface MutationOperation {
    profile: string;
    owner: string;
    room: string;
    chat: string;
    event: string;
    target: string;
    commands: NodeMutationRequest[];
}
export type MutationState =
    | 'PREPARED'
    | 'DISPATCHING'
    | 'APPLIED'
    | 'OUTCOME_UNKNOWN'
    | 'REJECTED'
    | 'CANCELLED';
function serialize(value: MutationOperation): string {
    if (
        !value ||
        Object.keys(value).some(
            (key) =>
                !['profile', 'owner', 'room', 'chat', 'event', 'target', 'commands'].includes(key),
        ) ||
        typeof value.owner !== 'string' ||
        !/^@[^\s]{1,1024}:[^\s]+$/.test(value.owner) ||
        typeof value.room !== 'string' ||
        !/^![^\s]{1,1024}:[^\s]+$/.test(value.room) ||
        typeof value.event !== 'string' ||
        !/^\$[^\s]{1,1024}$/.test(value.event) ||
        typeof value.target !== 'string' ||
        !/^\$[^\s]{1,1024}$/.test(value.target) ||
        value.event === value.target ||
        !Array.isArray(value.commands) ||
        value.commands.length < 1 ||
        value.commands.length > 1024
    )
        throw new Error('Invalid mutation operation');
    const commands = value.commands.map(parseMutationCommand);
    if (
        commands.some(
            (command) => command.profile !== value.profile || command.chatId !== value.chat,
        ) ||
        new Set(commands.map((command) => command.messageId)).size !== commands.length ||
        commands.reduce(
            (total, command) =>
                total + (command.action === 'edit' ? Buffer.byteLength(command.text) : 0),
            0,
        ) >
            1024 * 1024
    )
        throw new Error('Invalid mutation targets');
    return JSON.stringify({
        profile: value.profile,
        owner: value.owner,
        room: value.room,
        chat: value.chat,
        event: value.event,
        target: value.target,
        commands,
    });
}

/** Immutable per-part plan sharing the encrypted outbox connection and profile ownership. */
export class MutationJournal {
    private readonly db: Database.Database;
    constructor(db: Database.Database) {
        this.db = db;
    }
    static migrate(db: Database.Database): void {
        db.exec(`CREATE TABLE IF NOT EXISTS mutation_operations (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, event TEXT NOT NULL,
            chat TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(profile,event));
            CREATE TABLE IF NOT EXISTS mutation_parts (
                operation INTEGER NOT NULL REFERENCES mutation_operations(sequence), part INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHING','APPLIED','OUTCOME_UNKNOWN','REJECTED','CANCELLED')),
                reason TEXT, PRIMARY KEY(operation,part));
            CREATE INDEX IF NOT EXISTS mutation_chat_order ON mutation_operations(profile,chat,sequence);
            CREATE TABLE IF NOT EXISTS mutation_failure_notices (
                operation INTEGER NOT NULL REFERENCES mutation_operations(sequence),
                part INTEGER NOT NULL, PRIMARY KEY(operation,part));`);
    }
    prepare(operation: MutationOperation): void {
        const body = serialize(operation);
        this.db.transaction(() => {
            for (const table of ['requests', 'media_requests', 'reaction_operations', 'rejections'])
                if (
                    this.db
                        .prepare(`SELECT 1 FROM ${table} WHERE profile=? AND event=?`)
                        .get(operation.profile, operation.event)
                )
                    throw new Error('Mutation event already classified');
            const old = this.db
                .prepare('SELECT body FROM mutation_operations WHERE profile=? AND event=?')
                .get(operation.profile, operation.event) as {body: string} | undefined;
            if (old) {
                if (old.body !== body) throw new Error('Mutation plan conflict');
                return;
            }
            const row = this.db
                .prepare('INSERT INTO mutation_operations(profile,event,chat,body) VALUES(?,?,?,?)')
                .run(operation.profile, operation.event, operation.chat, body);
            const insert = this.db.prepare(
                "INSERT INTO mutation_parts(operation,part,state) VALUES(?,?,'PREPARED')",
            );
            operation.commands.forEach((_, part) => insert.run(row.lastInsertRowid, part));
        })();
    }
    get(
        profile: string,
        event: string,
    ):
        | {operation: MutationOperation; states: MutationState[]; reasons: (string | null)[]}
        | undefined {
        const row = this.db
            .prepare('SELECT sequence,body FROM mutation_operations WHERE profile=? AND event=?')
            .get(profile, event) as {sequence: number; body: string} | undefined;
        if (!row) return undefined;
        const operation = JSON.parse(row.body) as MutationOperation;
        serialize(operation);
        const parts = this.db
            .prepare('SELECT state,reason FROM mutation_parts WHERE operation=? ORDER BY part')
            .all(row.sequence) as {state: MutationState; reason: string | null}[];
        if (parts.length !== operation.commands.length)
            throw new Error('Incomplete mutation journal');
        return {
            operation,
            states: parts.map((part) => part.state),
            reasons: parts.map((part) => part.reason),
        };
    }
    peek(
        profile: string,
        excluded: readonly string[] = [],
    ): {operation: MutationOperation; part: number} | undefined {
        if (excluded.length > 1000) throw new Error('Mutation exclusion limit exceeded');
        const row = this.db
            .prepare(
                `SELECT o.body,p.part FROM mutation_operations o JOIN mutation_parts p ON p.operation=o.sequence
            WHERE o.profile=? AND p.state='PREPARED'
            ${excluded.length ? `AND o.chat NOT IN (${excluded.map(() => '?').join(',')})` : ''}
            AND NOT EXISTS (
                SELECT 1 FROM mutation_operations prior JOIN mutation_parts q ON q.operation=prior.sequence
                WHERE prior.profile=o.profile AND prior.chat=o.chat AND q.state NOT IN ('APPLIED','REJECTED','CANCELLED')
                AND (prior.sequence<o.sequence OR (prior.sequence=o.sequence AND q.part<p.part)))
            ORDER BY o.sequence,p.part LIMIT 1`,
            )
            .get(profile, ...excluded) as {body: string; part: number} | undefined;
        if (!row) return undefined;
        const operation = JSON.parse(row.body) as MutationOperation;
        serialize(operation);
        return {operation, part: row.part};
    }
    claim(profile: string, event: string, part: number, excluded: readonly string[] = []): boolean {
        return this.db.transaction(() => {
            const next = this.peek(profile, excluded);
            if (!next || next.operation.event !== event || next.part !== part) return false;
            return (
                this.db
                    .prepare(
                        "UPDATE mutation_parts SET state='DISPATCHING' WHERE operation=(SELECT sequence FROM mutation_operations WHERE profile=? AND event=?) AND part=? AND state='PREPARED'",
                    )
                    .run(profile, event, part).changes === 1
            );
        })();
    }
    finish(
        profile: string,
        event: string,
        part: number,
        state: 'APPLIED' | 'OUTCOME_UNKNOWN' | 'REJECTED',
        reason?: string,
    ): void {
        const codes = [
            'mutation-invalid',
            'mutation-permission-denied',
            'mutation-not-found',
            'mutation-unsupported',
            'edit-window-expired',
            'delete-window-expired',
        ];
        if (
            !Number.isSafeInteger(part) ||
            part < 0 ||
            !['APPLIED', 'OUTCOME_UNKNOWN', 'REJECTED'].includes(state) ||
            (state === 'REJECTED' ? !codes.includes(reason ?? '') : reason !== undefined)
        )
            throw new Error('Invalid mutation completion');
        this.db.transaction(() => {
            if (
                this.db
                    .prepare(
                        "UPDATE mutation_parts SET state=?,reason=? WHERE operation=(SELECT sequence FROM mutation_operations WHERE profile=? AND event=?) AND part=? AND state='DISPATCHING'",
                    )
                    .run(state, reason ?? null, profile, event, part).changes !== 1
            )
                throw new Error('Mutation part is not dispatching');
            if (state === 'REJECTED')
                this.db
                    .prepare(
                        "UPDATE mutation_parts SET state='CANCELLED' WHERE operation=(SELECT sequence FROM mutation_operations WHERE profile=? AND event=?) AND part>? AND state='PREPARED'",
                    )
                    .run(profile, event, part);
        })();
    }

    pendingFailures(
        profile: string,
        limit: number,
        after = 0,
    ): {
        sequence: number;
        operation: MutationOperation;
        part: number;
        reason: string;
        applied: number;
        cancelled: number;
    }[] {
        if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 1000 ||
            !Number.isSafeInteger(after) ||
            after < 0
        )
            throw new Error('Invalid mutation failure batch');
        const rows = this.db
            .prepare(
                `SELECT o.sequence,o.body,p.part,p.reason,
            (SELECT count(*) FROM mutation_parts a WHERE a.operation=o.sequence AND a.state='APPLIED') AS applied,
            (SELECT count(*) FROM mutation_parts c WHERE c.operation=o.sequence AND c.state='CANCELLED') AS cancelled
            FROM mutation_operations o JOIN mutation_parts p ON p.operation=o.sequence
            WHERE o.profile=? AND o.sequence>? AND p.state='REJECTED'
            AND NOT EXISTS (SELECT 1 FROM mutation_failure_notices n WHERE n.operation=o.sequence AND n.part=p.part)
            ORDER BY o.sequence LIMIT ?`,
            )
            .all(profile, after, limit) as {
            sequence: number;
            body: string;
            part: number;
            reason: string;
            applied: number;
            cancelled: number;
        }[];
        return rows.map(({body, ...row}) => {
            const operation = JSON.parse(body) as MutationOperation;
            serialize(operation);
            return {...row, operation};
        });
    }
    acknowledgeFailure(profile: string, event: string, part: number): void {
        const result = this.db
            .prepare(
                `INSERT OR IGNORE INTO mutation_failure_notices(operation,part)
            SELECT o.sequence,p.part FROM mutation_operations o JOIN mutation_parts p ON p.operation=o.sequence
            WHERE o.profile=? AND o.event=? AND p.part=? AND p.state='REJECTED'`,
            )
            .run(profile, event, part);
        if (result.changes !== 1)
            throw new Error('Mutation failure is missing or already acknowledged');
    }
    uncertain(
        profile: string,
        limit: number,
        after = {sequence: 0, part: -1},
    ): {sequence: number; operation: MutationOperation; part: number}[] {
        if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 1000 ||
            !Number.isSafeInteger(after.sequence) ||
            after.sequence < 0 ||
            !Number.isSafeInteger(after.part) ||
            after.part < -1
        )
            throw new Error('Invalid mutation recovery page');
        const rows = this.db
            .prepare(
                `SELECT o.sequence,o.body,p.part FROM mutation_operations o JOIN mutation_parts p ON p.operation=o.sequence
            WHERE o.profile=? AND p.state='OUTCOME_UNKNOWN' AND (o.sequence>? OR (o.sequence=? AND p.part>?))
            ORDER BY o.sequence,p.part LIMIT ?`,
            )
            .all(profile, after.sequence, after.sequence, after.part, limit) as {
            sequence: number;
            body: string;
            part: number;
        }[];
        return rows.map(({body, ...row}) => {
            const operation = JSON.parse(body) as MutationOperation;
            serialize(operation);
            return {...row, operation};
        });
    }
    /** A match settles convergence only; neither a mismatch nor a stale observation resets dispatch. */
    observeDesiredState(profile: string, event: string, part: number, matches: boolean): boolean {
        if (typeof matches !== 'boolean' || !Number.isSafeInteger(part) || part < 0)
            throw new Error('Invalid mutation state observation');
        if (!matches) return false;
        return (
            this.db
                .prepare(
                    `UPDATE mutation_parts SET state='APPLIED'
            WHERE operation=(SELECT sequence FROM mutation_operations WHERE profile=? AND event=?)
            AND part=? AND state='OUTCOME_UNKNOWN'`,
                )
                .run(profile, event, part).changes === 1
        );
    }
    /** Latest attempted edit for this original owner event; prepared/rejected plans are not evidence. */
    matchesEditEcho(
        profile: string,
        owner: string,
        room: string,
        chat: string,
        target: string,
        message: string,
        text: string,
    ): boolean {
        const row = this.db
            .prepare(
                `SELECT o.body,p.part FROM mutation_operations o JOIN mutation_parts p ON p.operation=o.sequence
            WHERE o.profile=? AND o.chat=? AND json_extract(o.body,'$.target')=?
            AND json_extract(o.body,'$.owner')=? AND json_extract(o.body,'$.room')=?
            AND p.state IN ('DISPATCHING','OUTCOME_UNKNOWN','APPLIED')
            AND json_extract(o.body,'$.commands[' || p.part || '].messageId')=?
            ORDER BY o.sequence DESC LIMIT 1`,
            )
            .get(profile, chat, target, owner, room, message) as
            | {body: string; part: number}
            | undefined;
        if (!row) return false;
        const operation = JSON.parse(row.body) as MutationOperation;
        serialize(operation);
        const command = operation.commands[row.part];
        return command?.action === 'edit' && command.text === text;
    }
    recoverInterrupted(): void {
        this.db
            .prepare("UPDATE mutation_parts SET state='OUTCOME_UNKNOWN' WHERE state='DISPATCHING'")
            .run();
    }
}
