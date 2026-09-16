import {createHash, randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {decodeMessage, encodeMessage} from './message-codec.ts';
import type {NormalizedNodeMessage} from './history.ts';
import {encodeMetadata, decodeMetadata, type ProfileMetadata} from './metadata-codec.ts';

/** Atomic latest-state upserts and durable pending changes. No Matrix side effects occur here. */
export class MessageJournal {
    private readonly database: Database.Database;
    private readonly profileId: string;
    constructor(filename: string, key: Buffer, profileId: string) {
        this.profileId = profileId;
        if (!isAbsolute(filename) || key.length !== 32 || !/^[A-Z0-9*][A-Z0-9]{7}$/.test(profileId))
            throw new Error('Invalid message journal options');
        const parent = lstatSync(dirname(filename));
        if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0)
            throw new Error('Journal requires a private directory');
        try {
            if (lstatSync(filename).isSymbolicLink())
                throw new Error('Journal cannot be a symlink');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.database = new Database(filename);
        try {
            this.database.pragma('cipher_compatibility = 4');
            this.database.pragma(`key = "x'${key.toString('hex')}'"`);
            this.database.pragma('cipher_log_level = NONE');
            this.database.pragma('journal_mode = WAL');
            this.database.pragma('synchronous = FULL');
            this.database.pragma('foreign_keys = ON');
            const version = this.database.pragma('user_version', {simple: true});
            if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4)
                throw new Error('Unsupported message journal schema');
            this.database.transaction(() =>
                this.database.exec(`
                CREATE TABLE IF NOT EXISTS messages (
                    profile TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL,
                    digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(profile,chat,id)
                );
                CREATE TABLE IF NOT EXISTS changes (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile TEXT NOT NULL, body TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS changes_profile ON changes(profile,sequence);
                CREATE TABLE IF NOT EXISTS reconciliations (
                    token TEXT PRIMARY KEY, profile TEXT NOT NULL, chat TEXT NOT NULL,
                    bytes INTEGER NOT NULL DEFAULT 0, UNIQUE(profile,chat)
                );
                CREATE TABLE IF NOT EXISTS staged_messages (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    token TEXT NOT NULL REFERENCES reconciliations(token) ON DELETE CASCADE,
                    phase INTEGER NOT NULL CHECK(phase IN (0,1)), body TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS staged_order ON staged_messages(token,phase,sequence);
                CREATE INDEX IF NOT EXISTS staged_phase_sequence ON staged_messages(phase,sequence);
                CREATE TABLE IF NOT EXISTS profile_metadata (
                    profile TEXT PRIMARY KEY, epoch TEXT NOT NULL, body TEXT NOT NULL,
                    pending INTEGER NOT NULL CHECK(pending IN (0,1))
                );
                CREATE TABLE IF NOT EXISTS journal_identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
                PRAGMA user_version = 4;
            `),
            )();
            this.database
                .prepare('INSERT OR IGNORE INTO journal_identity(id,value) VALUES (1,?)')
                .run(randomUUID());
        } catch (error) {
            this.database.close();
            throw error;
        }
    }
    changeOperationId(sequence: string): string {
        if (!/^[1-9][0-9]{0,18}$/.test(sequence) || BigInt(sequence) > 9223372036854775807n)
            throw new Error('Invalid journal sequence');
        const instance = this.database
            .prepare('SELECT value FROM journal_identity WHERE id=1')
            .get() as {value: string};
        return `threema_message_${instance.value}_${sequence}`;
    }
    /** Publish every chat and the matching metadata snapshot in the same transaction. */
    commitProfile(tokens: readonly string[], metadata: ProfileMetadata): string {
        const body = encodeMetadata(metadata);
        const epoch = randomUUID();
        this.database.transaction(() => {
            const expected = new Set(metadata.chats.map((chat) => chat.chatId));
            if (tokens.length !== expected.size || new Set(tokens).size !== tokens.length)
                throw new Error('Incomplete profile reconciliation');
            for (const token of tokens) {
                const row = this.database
                    .prepare('SELECT chat FROM reconciliations WHERE token=? AND profile=?')
                    .get(token, this.profileId) as {chat: string} | undefined;
                if (!row || !expected.delete(row.chat))
                    throw new Error('Mismatched profile reconciliation');
            }
            this.replayStaged(new Set(tokens));
            for (const token of tokens) this.abortReconciliation(token);
            this.database
                .prepare(
                    'INSERT INTO profile_metadata(profile,epoch,body,pending) VALUES (?,?,?,1) ON CONFLICT(profile) DO UPDATE SET epoch=excluded.epoch,body=excluded.body,pending=1',
                )
                .run(this.profileId, epoch, body);
        })();
        return epoch;
    }
    metadata(pendingOnly = false): (ProfileMetadata & {epoch: string}) | undefined {
        const row = this.database
            .prepare(
                'SELECT epoch,body FROM profile_metadata WHERE profile=? AND (?=0 OR pending=1)',
            )
            .get(this.profileId, pendingOnly ? 1 : 0) as {epoch: string; body: string} | undefined;
        return row ? {...decodeMetadata(row.body), epoch: row.epoch} : undefined;
    }
    acknowledgeMetadata(epoch: string): void {
        this.database
            .prepare('UPDATE profile_metadata SET pending=0 WHERE profile=? AND epoch=?')
            .run(this.profileId, epoch);
    }
    beginReconciliation(chatId: string): string {
        if (!/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(chatId))
            throw new Error('Invalid reconciliation chat');
        const token = randomUUID();
        this.database
            .prepare('INSERT INTO reconciliations(token,profile,chat) VALUES (?,?,?)')
            .run(token, this.profileId, chatId);
        return token;
    }
    stage(token: string, phase: 'snapshot' | 'live', message: NormalizedNodeMessage): void {
        const body = encodeMessage(message);
        if (phase !== 'snapshot' && phase !== 'live')
            throw new Error('Invalid reconciliation phase');
        this.database.transaction(() => {
            const updated = this.database
                .prepare(
                    'UPDATE reconciliations SET bytes=bytes+? WHERE token=? AND profile=? AND chat=? AND bytes+?<=134217728',
                )
                .run(
                    Buffer.byteLength(body),
                    token,
                    this.profileId,
                    message.chatId,
                    Buffer.byteLength(body),
                );
            if (updated.changes !== 1)
                throw new Error('Reconciliation unavailable or staging limit exceeded');
            this.database
                .prepare('INSERT INTO staged_messages(token,phase,body) VALUES (?,?,?)')
                .run(token, phase === 'snapshot' ? 0 : 1, body);
        })();
    }
    /** Persist a bounded history page atomically, with one durable commit per page. */
    stageSnapshotPage(token: string, messages: readonly NormalizedNodeMessage[]): void {
        if (!Array.isArray(messages) || messages.length > 500)
            throw new Error('Invalid snapshot page size');
        this.database.transaction(() => {
            for (const message of messages) this.stage(token, 'snapshot', message);
        })();
    }
    commitReconciliation(token: string): void {
        this.database.transaction(() => {
            if (
                !this.database
                    .prepare('SELECT 1 FROM reconciliations WHERE token=? AND profile=?')
                    .get(token, this.profileId)
            )
                throw new Error('Unknown reconciliation');
            this.replayStaged(new Set([token]));
            this.database
                .prepare('DELETE FROM reconciliations WHERE token=? AND profile=?')
                .run(token, this.profileId);
        })();
    }
    /** Called inside the publication transaction; retain bounded row batches while writing. */
    private replayStaged(tokens: ReadonlySet<string>): void {
        if (tokens.size === 0) return;
        for (const phase of [0, 1]) {
            let after = '0';
            while (true) {
                const rows = this.database
                    .prepare(
                        `SELECT CAST(s.sequence AS TEXT) AS sequence,s.token,s.body
                         FROM staged_messages s JOIN reconciliations r ON r.token=s.token
                         WHERE r.profile=? AND s.phase=? AND s.sequence>CAST(? AS INTEGER)
                         ORDER BY s.sequence LIMIT 16`,
                    )
                    .all(this.profileId, phase, after) as {
                    sequence: string;
                    token: string;
                    body: string;
                }[];
                if (rows.length === 0) break;
                for (const row of rows)
                    if (tokens.has(row.token)) this.upsert(decodeMessage(row.body));
                after = rows.at(-1)!.sequence;
            }
        }
    }
    abortReconciliation(token: string): void {
        this.database
            .prepare('DELETE FROM reconciliations WHERE token=? AND profile=?')
            .run(token, this.profileId);
    }
    /** Call only after acquiring exclusive profile ownership on restart. Incomplete work is never delivered. */
    discardIncompleteReconciliations(): void {
        this.database.prepare('DELETE FROM reconciliations WHERE profile=?').run(this.profileId);
    }
    upsert(message: NormalizedNodeMessage): 'changed' | 'duplicate' {
        const body = encodeMessage(message);
        const digest = createHash('sha256').update(body).digest('hex');
        const apply = () => {
            const old = this.database
                .prepare('SELECT digest FROM messages WHERE profile=? AND chat=? AND id=?')
                .get(this.profileId, message.chatId, message.messageId) as
                | {digest: string}
                | undefined;
            if (old?.digest === digest) return 'duplicate' as const;
            this.database
                .prepare(
                    'INSERT INTO messages VALUES (?,?,?,?,?) ON CONFLICT(profile,chat,id) DO UPDATE SET digest=excluded.digest,body=excluded.body',
                )
                .run(this.profileId, message.chatId, message.messageId, digest, body);
            this.database
                .prepare('INSERT INTO changes(profile,body) VALUES (?,?)')
                .run(this.profileId, body);
            return 'changed' as const;
        };
        return this.database.inTransaction ? apply() : this.database.transaction(apply)();
    }
    message(chat: string, id: string): NormalizedNodeMessage | undefined {
        const row = this.database
            .prepare('SELECT body FROM messages WHERE profile=? AND chat=? AND id=?')
            .get(this.profileId, chat, id) as {body: string} | undefined;
        return row ? decodeMessage(row.body) : undefined;
    }
    pending(limit = 100): {sequence: string; message: NormalizedNodeMessage}[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
            throw new Error('Invalid journal page size');
        const rows = this.database
            .prepare(
                'SELECT CAST(sequence AS TEXT) AS sequence,body FROM changes WHERE profile=? ORDER BY changes.sequence LIMIT ?',
            )
            .all(this.profileId, limit) as {sequence: string; body: string}[];
        return rows.map((row) => ({sequence: row.sequence, message: decodeMessage(row.body)}));
    }
    acknowledge(sequence: string): void {
        if (!/^[1-9][0-9]{0,18}$/.test(sequence) || BigInt(sequence) > 9223372036854775807n)
            throw new Error('Invalid journal sequence');
        this.database
            .prepare('DELETE FROM changes WHERE profile=? AND sequence=CAST(? AS INTEGER)')
            .run(this.profileId, sequence);
    }
    /** Check the opened encrypted database connection; does not assert free disk space. */
    pendingCount(): number {
        return (
            this.database
                .prepare('SELECT count(*) AS count FROM changes WHERE profile=?')
                .get(this.profileId) as {count: number}
        ).count;
    }
    checkHealth(): void {
        this.database.prepare('SELECT count(*) FROM sqlite_master').get();
    }
    close(): void {
        this.database.close();
    }
}
