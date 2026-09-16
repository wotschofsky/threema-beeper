import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';

export interface StoredTransaction {
    id: string;
    body: string;
    attempts: number;
}
export interface InboxEvent {
    /** Set only by the trusted native decoder, never copied from Matrix content. */
    encrypted?: boolean;
    event_id: string;
    room_id: string;
    sender: string;
    type: string;
    content: Record<string, unknown>;
    state_key?: string;
    origin_server_ts?: number;
    /** Older Matrix room versions carry the redaction target outside content. */
    redacts?: string;
}

export class TransactionConflictError extends Error {
    constructor() {
        super('Transaction identifier was reused with a different payload');
    }
}

function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        const serialized = JSON.stringify(value);
        assert.notEqual(serialized, undefined, 'Value must be JSON');
        return serialized!;
    }
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value)
        .sort()
        .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
}

/** Durable, encrypted transaction input and decrypted-event inbox; no remote side effects. */
export class TransactionInbox {
    private readonly database: Database.Database;

    public constructor(filename: string, key: Buffer) {
        assert.equal(key.length, 32, 'A 32-byte SQLCipher key is required');
        this.database = new Database(filename);
        try {
            this.database.pragma('cipher_compatibility = 4');
            this.database.pragma(`key = "x'${key.toString('hex')}'"`);
            this.database.pragma('cipher_log_level = NONE');
            this.database.pragma('journal_mode = WAL');
            this.database.pragma('synchronous = FULL');
            this.database.pragma('foreign_keys = ON');
            const version = this.database.pragma('user_version', {simple: true});
            assert.ok(
                version === 0 || version === 1 || version === 2 || version === 3,
                'Unsupported transaction inbox schema',
            );
            this.database.transaction(() => {
                this.database.exec(`
                    CREATE TABLE IF NOT EXISTS transactions (
                        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                        id TEXT NOT NULL UNIQUE,
                        digest TEXT NOT NULL,
                        body TEXT,
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'done')),
                        attempts INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE IF NOT EXISTS events (
                        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_id TEXT NOT NULL UNIQUE,
                        body TEXT NOT NULL,
                        transaction_id TEXT,
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'done'))
                    );
                    CREATE TABLE IF NOT EXISTS management_results (
                        event_id TEXT PRIMARY KEY REFERENCES events(event_id),
                        body TEXT NOT NULL
                    );

                `);
                if (version === 1)
                    this.database.exec('ALTER TABLE events ADD COLUMN transaction_id TEXT');
                this.database.exec(
                    'CREATE INDEX IF NOT EXISTS transactions_state ON transactions(state,sequence); CREATE INDEX IF NOT EXISTS events_state ON events(state,sequence);',
                );
                this.database.pragma('user_version = 3');
            })();
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    /** Returns only after the transaction is committed to the FULL-synchronous WAL. */
    public accept(id: string, body: unknown): 'accepted' | 'duplicate' {
        assert.ok(id.length > 0 && id.length <= 255, 'Invalid transaction identifier');
        const text = canonical(body);
        const digest = createHash('sha256').update(text).digest('hex');
        return this.database.transaction(() => {
            const existing = this.database
                .prepare('SELECT digest FROM transactions WHERE id = ?')
                .get(id) as {digest: string} | undefined;
            if (existing) {
                if (existing.digest !== digest) throw new TransactionConflictError();
                return 'duplicate' as const;
            }
            this.database
                .prepare('INSERT INTO transactions (id, digest, body) VALUES (?, ?, ?)')
                .run(id, digest, text);
            return 'accepted' as const;
        })();
    }

    public next(): StoredTransaction | undefined {
        return this.database
            .prepare(
                "SELECT id, body, attempts FROM transactions WHERE state = 'pending' ORDER BY sequence LIMIT 1",
            )
            .get() as StoredTransaction | undefined;
    }

    public pendingTransactions(limit: number): StoredTransaction[] {
        assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 1000);
        return this.database
            .prepare(
                "SELECT id, body, attempts FROM transactions WHERE state = 'pending' ORDER BY attempts, sequence LIMIT ?",
            )
            .all(limit) as StoredTransaction[];
    }

    public recordAttempt(id: string): void {
        const result = this.database
            .prepare(
                "UPDATE transactions SET attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
            )
            .run(id);
        assert.equal(result.changes, 1, 'Transaction is not pending');
    }

    /** Atomically saves decrypted events and finishes their source transaction. */
    public complete(id: string, events: readonly InboxEvent[]): void {
        this.database.transaction(() => {
            const transaction = this.database
                .prepare('SELECT state FROM transactions WHERE id = ?')
                .get(id) as {state: string} | undefined;
            assert.ok(transaction, 'Unknown transaction');
            if (transaction.state === 'done') return;
            for (const event of events) {
                // unsigned.age and other transport hints must not create false conflicts on retries.
                const normalized: InboxEvent = {
                    event_id: event.event_id,
                    room_id: event.room_id,
                    sender: event.sender,
                    type: event.type,
                    content: event.content,
                };
                if (event.encrypted === true) normalized.encrypted = true;
                if (event.state_key !== undefined) normalized.state_key = event.state_key;
                if (event.origin_server_ts !== undefined)
                    normalized.origin_server_ts = event.origin_server_ts;
                if (event.redacts !== undefined) {
                    assert.ok(
                        typeof event.redacts === 'string' &&
                            /^\$[^\s]{1,1024}$/.test(event.redacts),
                        'Invalid redaction target',
                    );
                    normalized.redacts = event.redacts;
                }
                const body = canonical(normalized);
                const existing = this.database
                    .prepare('SELECT body FROM events WHERE event_id = ?')
                    .get(event.event_id) as {body: string} | undefined;
                if (existing) {
                    assert.ok(
                        existing.body === body,
                        'Event identifier reused with conflicting content',
                    );
                } else {
                    this.database
                        .prepare(
                            'INSERT INTO events (event_id, body, transaction_id) VALUES (?, ?, ?)',
                        )
                        .run(event.event_id, body, id);
                }
            }
            this.database
                .prepare("UPDATE transactions SET state = 'done', body = NULL WHERE id = ?")
                .run(id);
        })();
    }

    public pendingEvents(limit = 100): InboxEvent[] {
        assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 1000);
        const rows = this.database
            .prepare("SELECT body FROM events WHERE state = 'pending' ORDER BY sequence LIMIT ?")
            .all(limit) as {body: string}[];
        return rows.map((row) => JSON.parse(row.body) as InboxEvent);
    }
    public event(eventId: string): InboxEvent | undefined {
        const row = this.database
            .prepare('SELECT body FROM events WHERE event_id=?')
            .get(eventId) as {body: string} | undefined;
        return row ? (JSON.parse(row.body) as InboxEvent) : undefined;
    }

    public eventPrecedes(first: string, second: string): boolean {
        return !!this.database
            .prepare(
                `SELECT 1 FROM events a JOIN transactions ta ON ta.id=a.transaction_id
            JOIN events b ON b.event_id=? JOIN transactions tb ON tb.id=b.transaction_id
            WHERE a.event_id=? AND (ta.sequence<tb.sequence OR (ta.sequence=tb.sequence AND a.sequence<b.sequence))`,
            )
            .get(second, first);
    }

    public sourcePosition(event: string): {transaction: number; event: number} | undefined {
        return this.database
            .prepare(
                `SELECT t.sequence AS "transaction",e.sequence AS event
            FROM events e JOIN transactions t ON t.id=e.transaction_id WHERE e.event_id=?`,
            )
            .get(event) as {transaction: number; event: number} | undefined;
    }

    /** Source arrival order survives delayed decryption and acknowledgement by other consumers. */
    public predecessorsPermit(eventId: string, permits: (event: InboxEvent) => boolean): boolean {
        const current = this.database
            .prepare(
                `SELECT e.sequence, t.sequence AS arrival, e.body
            FROM events e JOIN transactions t ON t.id=e.transaction_id WHERE e.event_id=?`,
            )
            .get(eventId) as {sequence: number; arrival: number; body: string} | undefined;
        if (!current) return false;
        const source = JSON.parse(current.body) as InboxEvent;
        // Room IDs remain visible in encrypted event envelopes. A missing key must hold
        // later work in that room, not every other conversation. Retain a conservative
        // barrier for legacy input without a validated events array.
        if (
            this.database
                .prepare(
                    `
            SELECT 1 FROM transactions t
            WHERE t.sequence<? AND t.state='pending' AND (
                COALESCE(json_type(t.body,'$.events'),'missing')!='array'
                OR EXISTS (SELECT 1 FROM json_each(t.body,'$.events') e
                    WHERE json_extract(e.value,'$.room_id')=?)
            ) LIMIT 1
        `,
                )
                .get(current.arrival, source.room_id)
        )
            return false;
        const rows = this.database
            .prepare(
                `SELECT e.body FROM events e
            LEFT JOIN transactions t ON t.id=e.transaction_id
            WHERE (t.sequence IS NULL OR t.sequence<? OR (t.sequence=? AND e.sequence<?))
              AND json_extract(e.body,'$.room_id')=? AND json_extract(e.body,'$.sender')=?
            ORDER BY t.sequence,e.sequence`,
            )
            .iterate(
                current.arrival,
                current.arrival,
                current.sequence,
                source.room_id,
                source.sender,
            );
        for (const row of rows)
            if (!permits(JSON.parse((row as {body: string}).body))) return false;
        return true;
    }

    public pendingDeliveryPage(
        limit = 100,
        after = 0,
    ): {sequence: number; event: InboxEvent; transactionId: string | null}[] {
        assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 1000);
        assert.ok(Number.isSafeInteger(after) && after >= 0);
        const rows = this.database
            .prepare(
                "SELECT sequence,body,transaction_id FROM events WHERE state='pending' AND sequence>? ORDER BY sequence LIMIT ?",
            )
            .all(after, limit) as {sequence: number; body: string; transaction_id: string | null}[];
        return rows.map((row) => ({
            sequence: row.sequence,
            event: JSON.parse(row.body) as InboxEvent,
            transactionId: row.transaction_id,
        }));
    }
    public pendingDeliveries(limit = 100): {event: InboxEvent; transactionId: string | null}[] {
        return this.pendingDeliveryPage(limit).map(({event, transactionId}) => ({
            event,
            transactionId,
        }));
    }
    public acknowledgeEvent(eventId: string): void {
        const result = this.database
            .prepare("UPDATE events SET state='done' WHERE event_id=?")
            .run(eventId);
        assert.equal(result.changes, 1, 'Unknown inbox event');
    }
    /** Immutable command output lives with its source event in the encrypted inbox. */
    public managementResult(eventId: string): Record<string, unknown> | undefined {
        const row = this.database
            .prepare('SELECT body FROM management_results WHERE event_id=?')
            .get(eventId) as {body: string} | undefined;
        return row ? JSON.parse(row.body) : undefined;
    }
    public saveManagementResult(eventId: string, content: Record<string, unknown>): void {
        assert.ok(content.msgtype === 'm.notice' && typeof content.body === 'string');
        assert.ok(Buffer.byteLength(content.body) <= 64 * 1024, 'Management output exceeds limit');
        assert.ok(
            Object.keys(content).every((key) => key === 'msgtype' || key === 'body'),
            'Management output must be a plain notice',
        );
        const body = canonical(content);
        this.database.transaction(() => {
            const existing = this.database
                .prepare('SELECT body FROM management_results WHERE event_id=?')
                .get(eventId) as {body: string} | undefined;
            if (existing) {
                assert.equal(existing.body, body, 'Management result conflict');
                return;
            }
            this.database
                .prepare('INSERT INTO management_results(event_id,body) VALUES (?,?)')
                .run(eventId, body);
        })();
    }
    /** Check the opened encrypted database connection; does not assert free disk space. */
    pendingCounts(): {transactions: number; events: number} {
        return this.database
            .prepare(
                `SELECT
            (SELECT count(*) FROM transactions WHERE state='pending') AS transactions,
            (SELECT count(*) FROM events WHERE state='pending') AS events`,
            )
            .get() as {transactions: number; events: number};
    }
    checkHealth(): void {
        this.database.prepare('SELECT count(*) FROM sqlite_master').get();
    }
    public close(): void {
        this.database.close();
    }
}
