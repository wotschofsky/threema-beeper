import {isDeepStrictEqual} from 'node:util';
import {lstatSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';

export interface EncryptedOperation {
    id: string;
    sender: string;
    room: string;
    digest: string;
    ciphertext: string;
    event: string | null;
}

export interface MessageMapping {
    profile: string;
    chat: string;
    message: string;
    room: string;
    sender: string;
    root: string;
    latest: string;
    digest: string;
}
export interface MessageProjection {
    id: string;
    profile: string;
    chat: string;
    message: string;
    room: string;
    sender: string;
    fingerprint: string;
    digest: string;
    root: string | null;
    content: string;
}

export class PortalStore {
    private readonly db: Database.Database;
    constructor(filename: string, key: Buffer) {
        if (!isAbsolute(filename) || key.length !== 32)
            throw new Error('Invalid portal store options');
        const parent = lstatSync(dirname(filename));
        if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0)
            throw new Error('Portal store requires a private directory');
        try {
            if (lstatSync(filename).isSymbolicLink())
                throw new Error('Portal store cannot be a symlink');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.db = new Database(filename);
        try {
            this.db.pragma('cipher_compatibility = 4');
            this.db.pragma(`key = "x'${key.toString('hex')}'"`);
            this.db.pragma('cipher_log_level = NONE');
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = FULL');
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
                version !== 9
            )
                throw new Error('Unsupported portal schema');
            // Schema, copied mappings and version must commit together. A late index
            // failure must not leave an older profile partially migrated.
            this.db.transaction(() => {
                this.db.exec(
                    'CREATE TABLE IF NOT EXISTS portals(profile TEXT NOT NULL,chat TEXT NOT NULL,room TEXT NOT NULL,PRIMARY KEY(profile,chat),UNIQUE(room)); CREATE TABLE IF NOT EXISTS encrypted_operations(id TEXT PRIMARY KEY,sender TEXT NOT NULL,room TEXT NOT NULL,digest TEXT NOT NULL,ciphertext TEXT NOT NULL,event TEXT); CREATE TABLE IF NOT EXISTS ghosts(profile TEXT NOT NULL,identity TEXT NOT NULL,mxid TEXT NOT NULL UNIQUE,PRIMARY KEY(profile,identity)); CREATE TABLE IF NOT EXISTS message_mappings(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,room TEXT NOT NULL,sender TEXT NOT NULL,root TEXT NOT NULL,latest TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(profile,chat,message)); CREATE TABLE IF NOT EXISTS message_projections(id TEXT PRIMARY KEY,profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,room TEXT NOT NULL,sender TEXT NOT NULL,fingerprint TEXT NOT NULL,digest TEXT NOT NULL,root TEXT,content TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS pending_message_projection ON message_projections(profile,chat,message); CREATE TABLE IF NOT EXISTS reactions(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,identity TEXT NOT NULL,emoji TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(profile,chat,message,identity,emoji)); CREATE TABLE IF NOT EXISTS message_versions(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,event TEXT NOT NULL,redacted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(profile,chat,message,event)); CREATE TABLE IF NOT EXISTS message_histories(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(profile,chat,message)); CREATE TABLE IF NOT EXISTS message_deletions(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(profile,chat,message)); INSERT OR IGNORE INTO message_histories SELECT profile,chat,message,0 FROM message_mappings; INSERT OR IGNORE INTO message_versions(profile,chat,message,event) SELECT profile,chat,message,root FROM message_mappings; INSERT OR IGNORE INTO message_versions(profile,chat,message,event) SELECT profile,chat,message,latest FROM message_mappings; CREATE TABLE IF NOT EXISTS message_statuses(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(profile,chat,message)); CREATE TABLE IF NOT EXISTS receipt_positions(profile TEXT NOT NULL,chat TEXT NOT NULL,reader TEXT NOT NULL,ordinal TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(profile,chat,reader)); CREATE TABLE IF NOT EXISTS media_uploads(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,prepared TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS read_targets(profile TEXT NOT NULL,chat TEXT NOT NULL,event TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(profile,chat,event)); PRAGMA user_version=9;',
                );
                this.db.exec(
                    "CREATE INDEX IF NOT EXISTS encrypted_echo_lookup ON encrypted_operations(sender,room,CASE WHEN json_valid(ciphertext) THEN json_extract(ciphertext, '$.session_id') END)",
                );
                this.db.exec(
                    'CREATE INDEX IF NOT EXISTS encrypted_echo_event ON encrypted_operations(event,sender,room) WHERE event IS NOT NULL',
                );
            })();
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    get(profile: string, chat: string): string | undefined {
        return (
            this.db
                .prepare('SELECT room FROM portals WHERE profile=? AND chat=?')
                .get(profile, chat) as {room: string} | undefined
        )?.room;
    }
    bind(profile: string, chat: string, room: string): void {
        this.db.transaction(() => {
            const old = this.get(profile, chat);
            if (old && old !== room) throw new Error('Portal mapping conflict');
            this.db
                .prepare('INSERT OR IGNORE INTO portals(profile,chat,room) VALUES (?,?,?)')
                .run(profile, chat, room);
            if (this.get(profile, chat) !== room) throw new Error('Room is already mapped');
        })();
    }
    /** Offline repair only: caller stops delivery and verifies the replacement's remote state. */
    replaceRoom(profile: string, chat: string, expectedRoom: string, replacement: string): void {
        if (!/^![^\s]+:[^\s]+$/.test(replacement)) throw new Error('Invalid replacement room');
        this.db.transaction(() => {
            const current = this.get(profile, chat);
            if (current === replacement) return;
            if (current !== expectedRoom) throw new Error('Portal mapping changed');
            if (
                this.db
                    .prepare('SELECT 1 FROM message_projections WHERE profile=? AND chat=? LIMIT 1')
                    .get(profile, chat) ||
                this.db
                    .prepare(
                        'SELECT 1 FROM encrypted_operations WHERE room=? AND event IS NULL LIMIT 1',
                    )
                    .get(expectedRoom)
            )
                throw new Error('Portal has unfinished delivery');
            // Preserve message roots, versions, receipts and ciphertext in the historical room.
            // Its removal from the active mapping also prevents dispatching new sends there.
            this.db
                .prepare('UPDATE portals SET room=? WHERE profile=? AND chat=? AND room=?')
                .run(replacement, profile, chat, expectedRoom);
        })();
    }
    /** Offline cleanup: caller also verifies no remote history, native history or outbox work. */
    retireEmptyRoom(profile: string, chat: string, expectedRoom: string): void {
        this.db.transaction(() => {
            const current = this.get(profile, chat);
            if (current === undefined) return;
            if (current !== expectedRoom) throw new Error('Portal mapping changed');
            for (const table of [
                'message_mappings',
                'message_projections',
                'message_versions',
                'message_histories',
                'message_deletions',
                'message_statuses',
                'reactions',
                'receipt_positions',
            ]) {
                if (
                    this.db
                        .prepare(`SELECT 1 FROM ${table} WHERE profile=? AND chat=? LIMIT 1`)
                        .get(profile, chat)
                )
                    throw new Error('Portal has history or pending work');
            }
            if (
                this.db
                    .prepare('SELECT 1 FROM encrypted_operations WHERE room=? LIMIT 1')
                    .get(expectedRoom)
            )
                throw new Error('Portal has encrypted history or pending work');
            this.db
                .prepare('DELETE FROM portals WHERE profile=? AND chat=? AND room=?')
                .run(profile, chat, expectedRoom);
        })();
    }
    portalForRoom(room: string): {profile: string; chat: string} | undefined {
        return this.db.prepare('SELECT profile,chat FROM portals WHERE room=?').get(room) as
            | {profile: string; chat: string}
            | undefined;
    }
    messageForEvent(profile: string, chat: string, event: string): string | undefined {
        return (
            this.db
                .prepare(
                    'SELECT message FROM message_versions WHERE profile=? AND chat=? AND event=?',
                )
                .get(profile, chat, event) as {message: string} | undefined
        )?.message;
    }
    bindReadTarget(profile: string, chat: string, event: string, message: string): void {
        if (!this.messageMapping(profile, chat, message))
            throw new Error('Read target is not mapped');
        this.db
            .prepare(
                'INSERT OR IGNORE INTO read_targets(profile,chat,event,message) VALUES (?,?,?,?)',
            )
            .run(profile, chat, event, message);
        if (this.readTarget(profile, chat, event) !== message)
            throw new Error('Read target conflict');
    }
    readTarget(profile: string, chat: string, event: string): string | undefined {
        return (
            this.db
                .prepare('SELECT message FROM read_targets WHERE profile=? AND chat=? AND event=?')
                .get(profile, chat, event) as {message: string} | undefined
        )?.message;
    }
    ownNonMessageEvent(room: string, event: string): boolean {
        return !!this.db
            .prepare(
                "SELECT 1 FROM encrypted_operations WHERE room=? AND event=? AND (id GLOB 'status_*' OR id GLOB 'reaction_*' OR id GLOB 'mutation_failure_*' OR id GLOB 'unsupported_*' OR id GLOB 'send_failure_*')",
            )
            .get(room, event);
    }
    ghost(profile: string, identity: string): string | undefined {
        return (
            this.db
                .prepare('SELECT mxid FROM ghosts WHERE profile=? AND identity=?')
                .get(profile, identity) as {mxid: string} | undefined
        )?.mxid;
    }
    bindGhost(profile: string, identity: string, mxid: string): void {
        this.db.transaction(() => {
            const old = this.ghost(profile, identity);
            if (old && old !== mxid) throw new Error('Ghost mapping conflict');
            this.db
                .prepare('INSERT OR IGNORE INTO ghosts(profile,identity,mxid) VALUES (?,?,?)')
                .run(profile, identity, mxid);
            if (this.ghost(profile, identity) !== mxid)
                throw new Error('Ghost user is already mapped');
        })();
    }
    messageMapping(profile: string, chat: string, message: string): MessageMapping | undefined {
        return this.db
            .prepare('SELECT * FROM message_mappings WHERE profile=? AND chat=? AND message=?')
            .get(profile, chat, message) as MessageMapping | undefined;
    }
    /** Associate a canonical local echo with an existing owner event, without sending a room event. */
    bindOwnerEcho(value: MessageMapping): void {
        this.db.transaction(() => {
            if (this.get(value.profile, value.chat) !== value.room)
                throw new Error('Echo portal conflict');
            const old = this.messageMapping(value.profile, value.chat, value.message);
            if (old) {
                if (
                    old.root !== value.root ||
                    old.room !== value.room ||
                    old.sender !== value.sender
                )
                    throw new Error('Echo message mapping conflict');
                return;
            }
            const pending = this.db
                .prepare(
                    'SELECT 1 FROM message_projections WHERE profile=? AND chat=? AND message=?',
                )
                .get(value.profile, value.chat, value.message);
            if (pending) throw new Error('Echo has a pending Matrix projection');
            this.db
                .prepare(
                    'INSERT INTO message_mappings(profile,chat,message,room,sender,root,latest,digest) VALUES(@profile,@chat,@message,@room,@sender,@root,@latest,@digest)',
                )
                .run(value);
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO message_histories(profile,chat,message,complete) VALUES(?,?,?,1)',
                )
                .run(value.profile, value.chat, value.message);
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO message_versions(profile,chat,message,event) VALUES(?,?,?,?)',
                )
                .run(value.profile, value.chat, value.message, value.root);
        })();
    }
    projection(id: string): MessageProjection | undefined {
        return this.db.prepare('SELECT * FROM message_projections WHERE id=?').get(id) as
            | MessageProjection
            | undefined;
    }
    prepareProjection(value: MessageProjection): MessageProjection {
        this.db
            .prepare(
                'INSERT OR IGNORE INTO message_projections(id,profile,chat,message,room,sender,fingerprint,digest,root,content) VALUES (@id,@profile,@chat,@message,@room,@sender,@fingerprint,@digest,@root,@content)',
            )
            .run(value);
        const stored = this.projection(value.id);
        if (!stored) throw new Error('Message has an unfinished projection');
        if (stored.fingerprint !== value.fingerprint)
            throw new Error('Message projection conflict');
        return stored;
    }
    finishProjection(id: string, event: string): void {
        this.db.transaction(() => {
            const plan = this.projection(id);
            if (!plan || this.operation(id)?.event !== event)
                throw new Error('Message projection not delivered');
            const old = this.messageMapping(plan.profile, plan.chat, plan.message);
            if (
                old &&
                (old.root !== plan.root || old.room !== plan.room || old.sender !== plan.sender)
            )
                throw new Error('Message mapping conflict');
            this.db
                .prepare(
                    'INSERT INTO message_mappings(profile,chat,message,room,sender,root,latest,digest) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(profile,chat,message) DO UPDATE SET latest=excluded.latest,digest=excluded.digest',
                )
                .run(
                    plan.profile,
                    plan.chat,
                    plan.message,
                    plan.room,
                    plan.sender,
                    plan.root ?? event,
                    event,
                    plan.digest,
                );
            if (!old)
                this.db
                    .prepare(
                        'INSERT INTO message_histories(profile,chat,message,complete) VALUES (?,?,?,1)',
                    )
                    .run(plan.profile, plan.chat, plan.message);
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO message_versions(profile,chat,message,event) VALUES (?,?,?,?)',
                )
                .run(plan.profile, plan.chat, plan.message, event);
            this.db.prepare('DELETE FROM message_projections WHERE id=?').run(id);
        })();
    }
    reactions(
        profile: string,
        chat: string,
        message: string,
    ): {identity: string; emoji: string; event: string}[] {
        return this.db
            .prepare(
                'SELECT identity,emoji,event FROM reactions WHERE profile=? AND chat=? AND message=? ORDER BY identity,emoji',
            )
            .all(profile, chat, message) as {identity: string; emoji: string; event: string}[];
    }
    bindReaction(
        profile: string,
        chat: string,
        message: string,
        identity: string,
        emoji: string,
        event: string,
    ): void {
        this.db.transaction(() => {
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO reactions(profile,chat,message,identity,emoji,event) VALUES (?,?,?,?,?,?)',
                )
                .run(profile, chat, message, identity, emoji, event);
            const stored = this.db
                .prepare(
                    'SELECT event FROM reactions WHERE profile=? AND chat=? AND message=? AND identity=? AND emoji=?',
                )
                .get(profile, chat, message, identity, emoji) as {event: string};
            if (stored.event !== event) throw new Error('Reaction mapping conflict');
        })();
    }
    removeReaction(
        profile: string,
        chat: string,
        message: string,
        identity: string,
        emoji: string,
        event: string,
    ): void {
        this.db
            .prepare(
                'DELETE FROM reactions WHERE profile=? AND chat=? AND message=? AND identity=? AND emoji=? AND event=?',
            )
            .run(profile, chat, message, identity, emoji, event);
    }
    deletion(profile: string, chat: string, message: string): {done: number} | undefined {
        return this.db
            .prepare('SELECT done FROM message_deletions WHERE profile=? AND chat=? AND message=?')
            .get(profile, chat, message) as {done: number} | undefined;
    }
    beginDeletion(profile: string, chat: string, message: string): void {
        if (
            this.db
                .prepare(
                    'SELECT 1 FROM message_projections WHERE profile=? AND chat=? AND message=?',
                )
                .get(profile, chat, message)
        )
            throw new Error('Message projection is still pending');
        this.db
            .prepare('INSERT OR IGNORE INTO message_deletions(profile,chat,message) VALUES (?,?,?)')
            .run(profile, chat, message);
    }
    versionsForDeletion(profile: string, chat: string, message: string): string[] {
        if (this.messageMapping(profile, chat, message)) {
            const coverage = this.db
                .prepare(
                    'SELECT complete FROM message_histories WHERE profile=? AND chat=? AND message=?',
                )
                .get(profile, chat, message) as {complete: number} | undefined;
            if (coverage?.complete !== 1)
                throw new Error('Legacy message requires event history reconciliation');
        }
        return (
            this.db
                .prepare(
                    'SELECT event FROM message_versions WHERE profile=? AND chat=? AND message=? AND redacted=0 ORDER BY event',
                )
                .all(profile, chat, message) as {event: string}[]
        ).map((row) => row.event);
    }
    markVersionRedacted(profile: string, chat: string, message: string, event: string): void {
        this.db
            .prepare(
                'UPDATE message_versions SET redacted=1 WHERE profile=? AND chat=? AND message=? AND event=?',
            )
            .run(profile, chat, message, event);
    }
    finishDeletion(profile: string, chat: string, message: string): void {
        if (
            this.versionsForDeletion(profile, chat, message).length ||
            this.reactions(profile, chat, message).length
        )
            throw new Error('Deletion is incomplete');
        this.db
            .prepare('UPDATE message_deletions SET done=1 WHERE profile=? AND chat=? AND message=?')
            .run(profile, chat, message);
    }
    messageStatus(profile: string, chat: string, message: string): string | undefined {
        return (
            this.db
                .prepare(
                    'SELECT body FROM message_statuses WHERE profile=? AND chat=? AND message=?',
                )
                .get(profile, chat, message) as {body: string} | undefined
        )?.body;
    }
    saveMessageStatus(profile: string, chat: string, message: string, body: string): void {
        this.db
            .prepare(
                'INSERT INTO message_statuses(profile,chat,message,body) VALUES (?,?,?,?) ON CONFLICT(profile,chat,message) DO UPDATE SET body=excluded.body',
            )
            .run(profile, chat, message, body);
    }
    receiptPosition(
        profile: string,
        chat: string,
        reader: string,
    ): {ordinal: string; message: string} | undefined {
        return this.db
            .prepare(
                'SELECT ordinal,message FROM receipt_positions WHERE profile=? AND chat=? AND reader=?',
            )
            .get(profile, chat, reader) as {ordinal: string; message: string} | undefined;
    }
    saveReceiptPosition(
        profile: string,
        chat: string,
        reader: string,
        ordinal: bigint,
        message: string,
    ): void {
        this.db.transaction(() => {
            const old = this.receiptPosition(profile, chat, reader);
            if (
                old &&
                (BigInt(old.ordinal) > ordinal ||
                    (BigInt(old.ordinal) === ordinal && old.message >= message))
            )
                return;
            this.db
                .prepare(
                    'INSERT INTO receipt_positions(profile,chat,reader,ordinal,message) VALUES (?,?,?,?,?) ON CONFLICT(profile,chat,reader) DO UPDATE SET ordinal=excluded.ordinal,message=excluded.message',
                )
                .run(profile, chat, reader, ordinal.toString(), message);
        })();
    }
    mediaUpload(
        id: string,
    ): {fingerprint: string; prepared: string; result: string | null} | undefined {
        return this.db
            .prepare('SELECT fingerprint,prepared,result FROM media_uploads WHERE id=?')
            .get(id) as {fingerprint: string; prepared: string; result: string | null} | undefined;
    }
    /** Read all retained spool references before startup cleanup can remove anything. */
    pendingMediaSpools(): Set<string> {
        const spools = new Set<string>();
        for (const row of this.db
            .prepare('SELECT prepared FROM media_uploads WHERE result IS NULL')
            .iterate() as Iterable<{prepared: string}>) {
            const value: unknown = JSON.parse(row.prepared);
            if (
                !value ||
                typeof value !== 'object' ||
                !('spoolId' in value) ||
                typeof value.spoolId !== 'string' ||
                !/^attachment-[A-Za-z0-9]{6}$/.test(value.spoolId)
            )
                throw new Error('Invalid pending media spool reference');
            spools.add(value.spoolId);
        }
        return spools;
    }
    prepareMediaUpload(id: string, fingerprint: string, prepared: string): void {
        this.db.transaction(() => {
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO media_uploads(id,fingerprint,prepared) VALUES (?,?,?)',
                )
                .run(id, fingerprint, prepared);
            const old = this.mediaUpload(id)!;
            if (old.fingerprint !== fingerprint || old.prepared !== prepared)
                throw new Error('Media upload operation conflict');
        })();
    }
    /** Replace only the observed unfinished upload; completed metadata is immutable. */
    replaceMediaUpload(id: string, fingerprint: string, previous: string, prepared: string): void {
        const result = this.db
            .prepare(
                'UPDATE media_uploads SET prepared=? WHERE id=? AND fingerprint=? AND prepared=? AND result IS NULL',
            )
            .run(prepared, id, fingerprint, previous);
        if (result.changes !== 1) throw new Error('Media upload recovery conflict');
    }
    completeMediaUpload(id: string, result: string): void {
        this.db.transaction(() => {
            const old = this.mediaUpload(id);
            if (!old || (old.result !== null && old.result !== result))
                throw new Error('Media upload completion conflict');
            this.db.prepare('UPDATE media_uploads SET result=? WHERE id=?').run(result, id);
        })();
    }
    /** Match persisted wire content even if its send response has not arrived yet. */
    isOwnEncryptedEvent(
        sender: string,
        room: string,
        content: Record<string, unknown>,
        eventId?: string,
    ): boolean {
        if (
            content.algorithm !== 'm.megolm.v1.aes-sha2' ||
            typeof content.ciphertext !== 'string' ||
            !content.ciphertext ||
            typeof content.session_id !== 'string' ||
            !content.session_id
        )
            return false;
        if (
            eventId &&
            this.db
                .prepare(
                    'SELECT 1 FROM encrypted_operations WHERE event=? AND sender=? AND room=? LIMIT 1',
                )
                .get(eventId, sender, room)
        )
            return true;
        const candidate = this.db
            .prepare(
                "SELECT ciphertext FROM encrypted_operations WHERE sender=? AND room=? AND CASE WHEN json_valid(ciphertext) THEN json_extract(ciphertext, '$.session_id') END=? AND json_extract(ciphertext, '$.ciphertext')=? LIMIT 1",
            )
            .get(sender, room, content.session_id, content.ciphertext) as
            | {ciphertext: string}
            | undefined;
        return (
            candidate !== undefined && isDeepStrictEqual(JSON.parse(candidate.ciphertext), content)
        );
    }
    operation(id: string): EncryptedOperation | undefined {
        return this.db.prepare('SELECT * FROM encrypted_operations WHERE id=?').get(id) as
            | EncryptedOperation
            | undefined;
    }
    prepareOperation(value: Omit<EncryptedOperation, 'event'>): EncryptedOperation {
        return this.db.transaction(() => {
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO encrypted_operations(id,sender,room,digest,ciphertext) VALUES (?,?,?,?,?)',
                )
                .run(value.id, value.sender, value.room, value.digest, value.ciphertext);
            const stored = this.operation(value.id)!;
            if (
                stored.sender !== value.sender ||
                stored.room !== value.room ||
                stored.digest !== value.digest
            )
                throw new Error('Encrypted operation conflict');
            return stored;
        })();
    }
    completeOperation(id: string, event: string): void {
        this.db.transaction(() => {
            const stored = this.operation(id);
            if (!stored || (stored.event !== null && stored.event !== event))
                throw new Error('Encrypted operation completion conflict');
            this.db
                .prepare("UPDATE encrypted_operations SET event=?,ciphertext='' WHERE id=?")
                .run(event, id);
        })();
    }
    /** Check the opened encrypted database connection; does not assert free disk space. */
    checkHealth(): void {
        this.db.prepare('SELECT count(*) FROM sqlite_master').get();
    }
    close(): void {
        this.db.close();
    }
}
