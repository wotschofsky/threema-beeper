import {parseVideoProjection, type VideoProjection} from './video-projection.ts';
import {parseAudioProjection, type AudioProjection} from './audio-projection.ts';
import {createHash} from 'node:crypto';
import type Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {resolveOutboundMedia, type OutboundMedia} from '../media/outbound-event.ts';
import {parseAllocatedIds} from '../threema/send-allocation.ts';
import {parseImageProjection, type ImageProjection} from './image-projection.ts';

export interface MediaRequest {
    id: string;
    profile: string;
    event: string;
    room: string;
    owner: string;
    transaction: string;
    media: OutboundMedia;
}
export type MediaState = 'PREPARED' | 'DISPATCHING' | 'SENT' | 'OUTCOME_UNKNOWN';
function normalize(request: MediaRequest): MediaRequest {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.id) ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(request.profile) ||
        !/^\$[^\s]{1,1024}$/.test(request.event) ||
        !/^![^\s]+:[^\s]+$/.test(request.room) ||
        !/^@[^\s]+:[^\s]+$/.test(request.owner) ||
        typeof request.transaction !== 'string' ||
        !request.transaction ||
        request.transaction.length > 255 ||
        !/^(c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(request.media?.chat)
    )
        throw new Error('Invalid media request');
    const media = request.media;
    const result = resolveOutboundMedia(
        {
            event_id: request.event,
            room_id: request.room,
            sender: request.owner,
            type: 'm.room.message',
            encrypted: true,
            content: {
                msgtype: media.kind,
                body: media.caption ?? media.filename,
                filename: media.filename,
                info: {
                    mimetype: media.mimeType,
                    ...(media.bytes === undefined ? {} : {size: media.bytes}),
                },
                file: media.file,
                ...(media.replyTo === undefined
                    ? {}
                    : {'m.relates_to': {'m.in_reply_to': {event_id: media.replyTo}}}),
            },
        },
        {
            profile: request.profile,
            owner: request.owner,
            maximumBytes: 1024 ** 3,
            portals: {portalForRoom: () => ({profile: request.profile, chat: media.chat})},
        },
    );
    if (result.kind !== 'resolved') throw new Error('Invalid media request');
    return {
        id: request.id,
        profile: request.profile,
        event: request.event,
        room: request.room,
        owner: request.owner,
        transaction: request.transaction,
        media: result.media,
    };
}
/** Shares the SQLCipher outbox transaction boundary. Prepared tokens are never persisted here. */
export class MediaJournal {
    private readonly db: Database.Database;
    constructor(db: Database.Database) {
        this.db = db;
    }
    reply(
        profile: string,
        event: string,
    ): {target: string; text: string; state: string; ids: string[]} | undefined {
        const row = this.db
            .prepare('SELECT target,text,state,ids FROM media_replies WHERE profile=? AND event=?')
            .get(profile, event) as
            | {target: string; text: string; state: string; ids: string}
            | undefined;
        return row ? {...row, ids: JSON.parse(row.ids)} : undefined;
    }
    prepareReply(profile: string, event: string, target: string, text: string): void {
        const request = this.get(profile, event)?.request;
        if (
            !request?.media.replyTo ||
            !/^m:[0-9a-f]{16}$/.test(target) ||
            !text ||
            Buffer.byteLength(text) > 4096
        )
            throw Error('Invalid attachment reply');
        this.db
            .prepare(
                "INSERT OR IGNORE INTO media_replies(profile,event,chat,target,text,state,ids) VALUES(?,?,?,?,?,'PREPARED','[]')",
            )
            .run(profile, event, request.media.chat, target, text);
        const existing = this.reply(profile, event)!;
        if (existing.target !== target || existing.text !== text)
            throw Error('Attachment reply conflict');
    }
    claimReply(profile: string, event: string): void {
        if (
            this.db
                .prepare(
                    "UPDATE media_replies SET state='DISPATCHING' WHERE profile=? AND event=? AND state='PREPARED'",
                )
                .run(profile, event).changes !== 1
        )
            throw Error('Attachment reply cannot be claimed');
    }
    replyIds(profile: string, event: string, ids: readonly string[]): void {
        parseAllocatedIds(ids);
        if (ids.length !== 1) throw Error('Attachment quote must be one text message');
        const row = this.reply(profile, event);
        if (
            !row ||
            !['DISPATCHING', 'SENT'].includes(row.state) ||
            (row.ids.length && JSON.stringify(row.ids) !== JSON.stringify(ids))
        )
            throw Error('Attachment reply ID conflict');
        this.db
            .prepare('UPDATE media_replies SET ids=? WHERE profile=? AND event=?')
            .run(JSON.stringify(ids), profile, event);
    }
    replySent(profile: string, event: string, ids: readonly string[]): void {
        this.replyIds(profile, event, ids);
        this.db
            .prepare("UPDATE media_replies SET state='SENT' WHERE profile=? AND event=?")
            .run(profile, event);
    }
    replyUnknown(profile: string, event: string): void {
        this.db
            .prepare(
                "UPDATE media_replies SET state='OUTCOME_UNKNOWN' WHERE profile=? AND event=? AND state='DISPATCHING'",
            )
            .run(profile, event);
    }
    observeReply(profile: string, chat: string, id: string, confirmed: boolean): boolean {
        const row = this.db
            .prepare(
                'SELECT event FROM media_replies WHERE profile=? AND chat=? AND EXISTS(SELECT 1 FROM json_each(ids) WHERE value=?)',
            )
            .get(profile, chat, id) as {event: string} | undefined;
        if (!row) return false;
        if (!confirmed) return true; // Recognize/suppress the companion without confirming transport.
        this.db
            .prepare("UPDATE media_replies SET state='SENT',observed=1 WHERE profile=? AND event=?")
            .run(profile, row.event);
        return true;
    }
    imageProjection(profile: string, event: string): ImageProjection | undefined {
        const row = this.db
            .prepare(
                'SELECT p.body FROM media_image_projections p JOIN media_requests r ON r.id=p.request WHERE r.profile=? AND r.event=?',
            )
            .get(profile, event) as {body: string} | undefined;
        return row ? parseImageProjection(JSON.parse(row.body)) : undefined;
    }
    recordImageProjection(profile: string, event: string, value: ImageProjection): void {
        const projection = parseImageProjection(value);
        this.db.transaction(() => {
            const record = this.get(profile, event);
            if (
                !record ||
                record.request.media.kind !== 'm.image' ||
                record.state !== 'DISPATCHING'
            )
                throw new Error('Image projection requires a dispatching image');
            const prior = this.imageProjection(profile, event);
            if (prior) {
                if (JSON.stringify(prior) !== JSON.stringify(projection))
                    throw new Error('Image projection conflict');
                return;
            }
            if (record.ids.length) throw new Error('Image projection must precede ID allocation');
            this.db
                .prepare('INSERT INTO media_image_projections(request,body) VALUES(?,?)')
                .run(record.request.id, JSON.stringify(projection));
        })();
    }
    audioProjection(profile: string, event: string): AudioProjection | undefined {
        const row = this.db
            .prepare(
                'SELECT p.body FROM media_audio_projections p JOIN media_requests r ON r.id=p.request WHERE r.profile=? AND r.event=?',
            )
            .get(profile, event) as {body: string} | undefined;
        return row ? parseAudioProjection(JSON.parse(row.body)) : undefined;
    }
    recordAudioProjection(profile: string, event: string, value: AudioProjection): void {
        const projection = parseAudioProjection(value);
        this.db.transaction(() => {
            const record = this.get(profile, event);
            if (
                !record ||
                record.request.media.kind !== 'm.audio' ||
                record.state !== 'DISPATCHING'
            )
                throw new Error('Audio projection requires a dispatching audio');
            const prior = this.audioProjection(profile, event);
            if (prior) {
                if (JSON.stringify(prior) !== JSON.stringify(projection))
                    throw new Error('Audio projection conflict');
                return;
            }
            if (record.ids.length) throw new Error('Audio projection must precede ID allocation');
            this.db
                .prepare('INSERT INTO media_audio_projections(request,body) VALUES(?,?)')
                .run(record.request.id, JSON.stringify(projection));
        })();
    }
    videoProjection(profile: string, event: string): VideoProjection | undefined {
        const row = this.db
            .prepare(
                'SELECT p.body FROM media_video_projections p JOIN media_requests r ON r.id=p.request WHERE r.profile=? AND r.event=?',
            )
            .get(profile, event) as {body: string} | undefined;
        return row ? parseVideoProjection(JSON.parse(row.body)) : undefined;
    }
    recordVideoProjection(profile: string, event: string, value: VideoProjection): void {
        const projection = parseVideoProjection(value);
        this.db.transaction(() => {
            const record = this.get(profile, event);
            if (
                !record ||
                record.request.media.kind !== 'm.video' ||
                record.state !== 'DISPATCHING'
            )
                throw new Error('Video projection requires a dispatching video');
            const prior = this.videoProjection(profile, event);
            if (prior) {
                if (JSON.stringify(prior) !== JSON.stringify(projection))
                    throw new Error('Video projection conflict');
                return;
            }
            if (record.ids.length) throw new Error('Video projection must precede ID allocation');
            this.db
                .prepare('INSERT INTO media_video_projections(request,body) VALUES(?,?)')
                .run(record.request.id, JSON.stringify(projection));
        })();
    }
    pendingCounts(profile: string): {
        prepared: number;
        dispatching: number;
        awaitingEcho: number;
        uncertain: number;
    } {
        return this.db
            .prepare(
                `SELECT
            count(CASE WHEN queue_state='PREPARED' THEN 1 END) AS prepared,
            count(CASE WHEN queue_state='DISPATCHING' THEN 1 END) AS dispatching,
            count(CASE WHEN queue_state='OUTCOME_UNKNOWN' THEN 1 END) AS uncertain,
            count(CASE WHEN queue_state='SENT' AND EXISTS (
                SELECT 1 FROM media_parts p WHERE p.request=r.id AND p.observed=0
            ) THEN 1 END) AS awaitingEcho
            FROM (SELECT r.*, CASE WHEN EXISTS (
                SELECT 1 FROM media_replies q WHERE q.profile=r.profile AND q.event=r.event
                AND q.state='OUTCOME_UNKNOWN'
            ) THEN 'OUTCOME_UNKNOWN' ELSE r.state END AS queue_state
            FROM media_requests r WHERE profile=?) r`,
            )
            .get(profile) as {
            prepared: number;
            dispatching: number;
            awaitingEcho: number;
            uncertain: number;
        };
    }
    static migrate(db: Database.Database): void {
        db.exec(`CREATE TABLE IF NOT EXISTS media_requests (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,profile TEXT NOT NULL,event TEXT NOT NULL,
            chat TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHING','SENT','OUTCOME_UNKNOWN')),UNIQUE(profile,event));
            CREATE TABLE IF NOT EXISTS media_parts(request TEXT NOT NULL REFERENCES media_requests(id),
                profile TEXT NOT NULL,message TEXT NOT NULL,part INTEGER NOT NULL,observed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(request,part),UNIQUE(profile,message));
            CREATE INDEX IF NOT EXISTS media_chat_order ON media_requests(profile,chat,sequence);`);
        db.exec(
            "CREATE TABLE IF NOT EXISTS media_replies(profile TEXT NOT NULL,event TEXT NOT NULL,chat TEXT NOT NULL,target TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHING','SENT','OUTCOME_UNKNOWN')),ids TEXT NOT NULL,PRIMARY KEY(profile,event),FOREIGN KEY(profile,event) REFERENCES media_requests(profile,event));",
        );
        db.exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS media_reply_id ON media_replies(profile,json_extract(ids,'$[0]')) WHERE json_array_length(ids)>0;",
        );
        const replyColumns = db.prepare('PRAGMA table_info(media_replies)').all() as {
            name: string;
        }[];
        if (!replyColumns.some((column) => column.name === 'observed'))
            db.exec(
                'ALTER TABLE media_replies ADD COLUMN observed INTEGER NOT NULL DEFAULT 0 CHECK(observed IN (0,1))',
            );
        const requestColumns = db.prepare('PRAGMA table_info(media_requests)').all() as {
            name: string;
        }[];
        if (!requestColumns.some((column) => column.name === 'retry_at'))
            db.exec(
                'ALTER TABLE media_requests ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE media_requests ADD COLUMN preflight_failures INTEGER NOT NULL DEFAULT 0;',
            );
        const columns = db.prepare('PRAGMA table_info(media_parts)').all() as {name: string}[];
        if (!columns.some((column) => column.name === 'observed'))
            db.exec('ALTER TABLE media_parts ADD COLUMN observed INTEGER NOT NULL DEFAULT 0');
        db.exec(
            'CREATE TABLE IF NOT EXISTS media_image_projections(request TEXT PRIMARY KEY REFERENCES media_requests(id),body TEXT NOT NULL);' +
                'CREATE TABLE IF NOT EXISTS media_audio_projections(request TEXT PRIMARY KEY REFERENCES media_requests(id),body TEXT NOT NULL);' +
                'CREATE TABLE IF NOT EXISTS media_video_projections(request TEXT PRIMARY KEY REFERENCES media_requests(id),body TEXT NOT NULL)',
        );
    }
    forMessage(profile: string, message: string): ReturnType<MediaJournal['get']> {
        const row = this.db
            .prepare(
                `SELECT r.event FROM media_parts p JOIN media_requests r ON r.id=p.request
            WHERE p.profile=? AND p.message=?`,
            )
            .get(profile, message) as {event: string} | undefined;
        return row ? this.get(profile, row.event) : undefined;
    }
    observe(profile: string, chat: string, message: string): void {
        this.db.transaction(() => {
            const record = this.forMessage(profile, message);
            if (!record || record.request.media.chat !== chat || record.state === 'PREPARED')
                throw new Error('Media echo state conflict');
            this.db
                .prepare('UPDATE media_parts SET observed=1 WHERE profile=? AND message=?')
                .run(profile, message);
            if (
                !this.db
                    .prepare('SELECT 1 FROM media_parts WHERE request=? AND observed=0 LIMIT 1')
                    .get(record.request.id)
            )
                this.db
                    .prepare("UPDATE media_requests SET state='SENT' WHERE id=?")
                    .run(record.request.id);
        })();
    }
    get(
        profile: string,
        event: string,
    ): {request: MediaRequest; state: MediaState; ids: string[]} | undefined {
        const row = this.db
            .prepare('SELECT body,state FROM media_requests WHERE profile=? AND event=?')
            .get(profile, event) as {body: string; state: MediaState} | undefined;
        if (!row) return undefined;
        const request = normalize(JSON.parse(row.body));
        const ids = (
            this.db
                .prepare('SELECT message FROM media_parts WHERE request=? ORDER BY part')
                .all(request.id) as {message: string}[]
        ).map((row) => row.message);
        if (ids.length) parseAllocatedIds(ids);
        return {request, state: row.state, ids};
    }
    prepare(value: MediaRequest): void {
        const request = normalize(value);
        const digest = createHash('sha256')
            .update(
                JSON.stringify([
                    request.profile,
                    request.event,
                    request.room,
                    request.owner,
                    request.media,
                ]),
            )
            .digest('hex');
        this.db.transaction(() => {
            const prior = this.db
                .prepare('SELECT digest FROM media_requests WHERE profile=? AND event=?')
                .get(request.profile, request.event) as {digest: string} | undefined;
            if (prior) {
                if (prior.digest !== digest) throw new Error('Media request conflict');
                return;
            }
            for (const table of [
                'requests',
                'reaction_operations',
                'rejections',
                'mutation_operations',
            ])
                if (
                    this.db
                        .prepare(`SELECT 1 FROM ${table} WHERE profile=? AND event=?`)
                        .get(request.profile, request.event)
                )
                    throw new Error('Media event already classified');
            this.db
                .prepare(
                    "INSERT INTO media_requests(id,profile,event,chat,body,digest,state) VALUES(?,?,?,?,?,?,'PREPARED')",
                )
                .run(
                    request.id,
                    request.profile,
                    request.event,
                    request.media.chat,
                    JSON.stringify(request),
                    digest,
                );
        })();
    }
    next(profile: string, excluded: readonly string[] = []): ReturnType<MediaJournal['get']> {
        if (excluded.length > 1000) throw new Error('Media exclusion limit exceeded');
        const row = this.db
            .prepare(
                `SELECT o.event FROM media_requests o WHERE o.profile=? AND o.state='PREPARED' AND o.retry_at<=?
            ${excluded.length ? `AND o.chat NOT IN (${excluded.map(() => '?').join(',')})` : ''}
            AND NOT EXISTS(SELECT 1 FROM media_requests prior WHERE prior.profile=o.profile AND prior.chat=o.chat
                AND prior.sequence<o.sequence AND prior.state!='SENT') ORDER BY o.sequence LIMIT 1`,
            )
            .get(profile, Date.now(), ...excluded) as {event: string} | undefined;
        return row ? this.get(profile, row.event) : undefined;
    }
    claim(profile: string, event: string, excluded: readonly string[] = []): boolean {
        return this.db.transaction(() => {
            const next = this.next(profile, excluded);
            if (next?.request.event !== event) return false;
            this.db
                .prepare(
                    "UPDATE media_requests SET state='DISPATCHING' WHERE profile=? AND event=?",
                )
                .run(profile, event);
            return true;
        })();
    }
    deferPreparation(profile: string, event: string): void {
        this.db
            .prepare(
                "UPDATE media_requests SET retry_at=? + min(300000,1000 * (1 << min(preflight_failures,18))),preflight_failures=preflight_failures+1 WHERE profile=? AND event=? AND state='PREPARED'",
            )
            .run(Date.now(), profile, event);
    }
    recordIds(profile: string, event: string, value: readonly string[]): void {
        const ids = parseAllocatedIds(value);
        this.db.transaction(() => {
            const record = this.get(profile, event);
            if (!record || record.state !== 'DISPATCHING')
                throw new Error('Media request is not dispatching');
            if (record.request.media.kind === 'm.image' && !this.imageProjection(profile, event))
                throw new Error('Image canonical projection is missing');
            if (record.request.media.kind === 'm.audio' && !this.audioProjection(profile, event))
                throw new Error('Audio canonical projection is missing');
            if (record.request.media.kind === 'm.video' && !this.videoProjection(profile, event))
                throw new Error('Video canonical projection is missing');
            if (record.ids.length) {
                if (JSON.stringify(record.ids) !== JSON.stringify(ids))
                    throw new Error('Media ID conflict');
                return;
            }
            for (const id of ids)
                if (
                    this.db
                        .prepare('SELECT 1 FROM parts WHERE profile=? AND message=?')
                        .get(profile, id)
                )
                    throw new Error('Media ID already belongs to text');
            const insert = this.db.prepare(
                'INSERT INTO media_parts(request,profile,message,part) VALUES(?,?,?,?)',
            );
            ids.forEach((id, part) => insert.run(record.request.id, profile, id, part));
        })();
    }
    sent(profile: string, event: string, ids: readonly string[]): void {
        this.db.transaction(() => {
            const record = this.get(profile, event);
            if (
                !record ||
                !['DISPATCHING', 'SENT'].includes(record.state) ||
                JSON.stringify(record.ids) !== JSON.stringify(parseAllocatedIds(ids))
            )
                throw new Error('Media send lacks matching durable IDs');
            this.db
                .prepare("UPDATE media_requests SET state='SENT' WHERE profile=? AND event=?")
                .run(profile, event);
        })();
    }
    unknown(profile: string, event: string): void {
        const result = this.db
            .prepare(
                "UPDATE media_requests SET state='OUTCOME_UNKNOWN' WHERE profile=? AND event=? AND state='DISPATCHING'",
            )
            .run(profile, event);
        if (result.changes !== 1 && this.get(profile, event)?.state !== 'SENT')
            throw new Error('Media request is not dispatching');
    }
    recoverInterrupted(): void {
        this.db
            .prepare(
                "UPDATE media_replies SET state='OUTCOME_UNKNOWN' WHERE state='DISPATCHING' OR (state='SENT' AND observed=0)",
            )
            .run();
        this.db
            .prepare(
                `UPDATE media_requests SET state='OUTCOME_UNKNOWN' WHERE state='DISPATCHING'
                OR (state='SENT' AND EXISTS (
                    SELECT 1 FROM media_parts WHERE request=media_requests.id AND observed=0
                ))`,
            )
            .run();
    }
}
