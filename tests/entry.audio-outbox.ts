import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {parseAudioProjection} from '../src/outbox/audio-projection.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';

await test('audio projection survives uncertain restart and matches only its canonical echo', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'audio-outbox-')),
        key = randomBytes(32);
    const filename = join(directory, 'outbox');
    let store = new OutboxStore(filename, key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const request: MediaRequest = {
        id: createRequestId(),
        profile: 'SELF1234',
        event: '$audio',
        room: '!room:invalid',
        owner: '@owner:invalid',
        transaction: 'audio',
        media: {
            chat: 'c:ABCD1234',
            kind: 'm.audio',
            filename: 'source.flac',
            mimeType: 'audio/flac',
            bytes: 12,
            file: {
                url: 'mxc://invalid/id',
                v: 'v2',
                key: {
                    kty: 'oct',
                    alg: 'A256CTR',
                    key_ops: ['decrypt'],
                    k: Buffer.alloc(32).toString('base64url'),
                },
                iv: Buffer.alloc(16).toString('base64'),
                hashes: {sha256: Buffer.alloc(32).toString('base64')},
            },
        },
    };
    const projection = parseAudioProjection({
        kind: 'audio',
        fileName: 'voice.m4a',
        mediaType: 'audio/mp4',
        bytes: 4321,
        durationSeconds: 0.25,
        caption: 'caption',
    });
    let sends = 0,
        discards = 0,
        mismatch = true;
    assert(projection.kind === 'audio');
    try {
        store.media.prepare(request);
        // Simulate the exact pre-audio schema, preserving its already durable request.
        store.close();
        const legacy = new Database(filename);
        try {
            legacy.pragma('cipher_compatibility = 4');
            legacy.pragma(`key = "x'${key.toString('hex')}'"`);
            legacy.pragma('cipher_log_level = NONE');
            legacy.exec('DROP TABLE media_audio_projections; PRAGMA user_version=10;');
        } finally {
            legacy.close();
        }
        store = new OutboxStore(filename, key);
        assert.equal(store.media.get(request.profile, request.event)!.state, 'PREPARED');
        assert.throws(() =>
            store.media.recordAudioProjection(request.profile, request.event, projection),
        );
        for (const difference of [
            {durationSeconds: 0},
            {durationSeconds: NaN},
            {durationSeconds: 10001},
            {mediaType: 'audio/flac'},
            {token: 'a'.repeat(64)},
            {bytes: 0},
        ])
            assert.throws(() => parseAudioProjection({...projection, ...difference}));
        const dispatcher = new MediaDispatcher({
            profile: request.profile,
            journal: store.media,
            ready: () => true,
            authorize: async () => {},
            prepare: async () => {
                throw new Error('File route used');
            },
            audio: {
                prepare: async () => ({
                    projection,
                    request: {
                        profile: request.profile,
                        chatId: request.media.chat,
                        token: 'a'.repeat(64),
                        fileName: projection.fileName,
                        mediaType: projection.mediaType,
                        caption: projection.caption,
                        audioDurationSeconds: mismatch ? 0.5 : projection.durationSeconds,
                    },
                    discard: async () => {
                        discards++;
                    },
                }),
            },
            backend: {
                sendPreparedFile: async (_command, persist) => {
                    sends++;
                    assert.deepEqual(
                        store.media.audioProjection(request.profile, request.event),
                        projection,
                    );
                    store.media.recordAudioProjection(request.profile, request.event, {
                        ...projection,
                    });
                    assert.throws(() =>
                        store.media.recordAudioProjection(request.profile, request.event, {
                            ...projection,
                            durationSeconds: 0.5,
                        }),
                    );
                    await persist(['m:0100000000000000']);
                    throw new Error('Unknown after allocation');
                },
            },
        });
        await assert.rejects(dispatcher.drain());
        assert.equal(sends, 0);
        assert.equal(discards, 1);
        assert.equal(store.media.get(request.profile, request.event)!.state, 'PREPARED');
        mismatch = false;
        assert.equal(await dispatcher.drain(), 0); // Preparation failures respect retry backoff.
        assert.equal(store.retryPrepared(request.profile), 1);
        await assert.rejects(dispatcher.drain());
        assert.equal(sends, 1);
        assert.equal(discards, 1);
        assert.throws(() =>
            store.media.recordAudioProjection(request.profile, request.event, {
                ...projection,
                durationSeconds: 0.5,
            }),
        );
        store.close();
        store = new OutboxStore(filename, key);
        store.recoverInterrupted();
        assert.deepEqual(store.media.audioProjection(request.profile, request.event), projection);
        assert.equal(store.media.get(request.profile, request.event)!.state, 'OUTCOME_UNKNOWN');
        assert.equal(store.media.next(request.profile), undefined);
        portals.bind(request.profile, request.media.chat, request.room);
        const echo: NormalizedNodeMessage = {
            direction: 'outbound',
            senderIdentity: request.profile,
            chatId: request.media.chat,
            messageId: 'm:0100000000000000',
            createdAt: new Date(1000),
            sentAt: new Date(1000),
            ordinal: 1n,
            reactions: [],
            content: {
                type: 'audio',
                fileName: projection.fileName,
                mimeType: projection.mediaType,
                byteSize: projection.bytes,
                durationSeconds: projection.durationSeconds,
                caption: projection.caption,
            },
        };
        for (const difference of [
            {durationSeconds: 0.5},
            {durationSeconds: undefined},
            {mimeType: 'audio/flac'},
            {fileName: 'source.flac'},
            {byteSize: 12},
            {caption: 'changed'},
            {type: 'file'},
        ])
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                    ...echo,
                    content: {...echo.content, ...difference},
                } as NormalizedNodeMessage),
            );
        assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, echo));
        assert.equal(store.media.get(request.profile, request.event)!.state, 'SENT');
        assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, echo));
        assert.equal(sends, 1);
        const missing = {...request, id: createRequestId(), event: '$missing-projection'};
        // Schema 11 already stored native-audio projections; schema 12 expands their kind.
        store.close();
        const version11 = new Database(filename);
        try {
            version11.pragma('cipher_compatibility = 4');
            version11.pragma(`key = "x'${key.toString('hex')}'"`);
            version11.pragma('cipher_log_level = NONE');
            version11.pragma('user_version = 11');
        } finally {
            version11.close();
        }
        store = new OutboxStore(filename, key);
        assert.deepEqual(store.media.audioProjection(request.profile, request.event), projection);
        assert.equal(store.media.get(request.profile, request.event)!.state, 'SENT');
        store.media.prepare(missing);
        assert(store.media.claim(request.profile, missing.event));
        assert.throws(() =>
            store.media.recordIds(request.profile, missing.event, ['m:0200000000000000']),
        );
    } finally {
        store.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
