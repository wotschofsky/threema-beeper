import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'media-dispatch-')),
        key = randomBytes(32),
        store = new OutboxStore(join(directory, 'outbox'), key);
    const profile = 'SELF1234';
    const request = (event: string, chat = 'c:ABCD1234'): MediaRequest => ({
        id: createRequestId(),
        profile,
        event,
        room: '!room:invalid',
        owner: '@owner:invalid',
        transaction: event,
        media: {
            chat,
            kind: 'm.file',
            filename: 'fixture',
            mimeType: 'application/octet-stream',
            bytes: 1,
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
    });
    return {
        store,
        profile,
        request,
        close: () => {
            store.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        },
    };
}
const sendRequest = (request: MediaRequest) => ({
    profile: request.profile,
    chatId: request.media.chat,
    token: 'a'.repeat(64),
    fileName: request.media.filename,
    mediaType: request.media.mimeType,
});
await test('preparation failures remain retryable and uncertain sends do not block unrelated chats', async () => {
    const f = fixture();
    let discarded = 0;
    const sent: string[] = [];
    try {
        f.store.media.prepare(f.request('$preflight'));
        f.store.media.prepare(f.request('$uncertain', 'c:OTHER123'));
        f.store.media.prepare(f.request('$success', 'c:THIRD123'));
        const dispatcher = new MediaDispatcher({
            profile: f.profile,
            journal: f.store.media,
            ready: () => true,
            authorize: async (r) => {
                if (r.event === '$preflight') throw new Error('denied');
            },
            prepare: async (r) => ({
                request: sendRequest(r),
                discard: async () => {
                    discarded++;
                },
            }),
            backend: {
                sendPreparedFile: async (r, persist) => {
                    sent.push(r.chatId);
                    const ids = [
                        r.chatId === 'c:OTHER123' ? 'm:0100000000000000' : 'm:0200000000000000',
                    ];
                    await persist(ids);
                    if (r.chatId === 'c:OTHER123') throw new Error('unknown');
                    return ids;
                },
            },
        });
        await assert.rejects(dispatcher.drain());
        assert.equal(f.store.media.get(f.profile, '$preflight')!.state, 'PREPARED');
        assert.equal(f.store.media.get(f.profile, '$uncertain')!.state, 'OUTCOME_UNKNOWN');
        assert.equal(f.store.media.get(f.profile, '$success')!.state, 'SENT');
        assert.deepEqual(sent, ['c:OTHER123', 'c:THIRD123']);
        assert.equal(discarded, 0);
        await assert.rejects(dispatcher.drain());
        assert.equal(sent.length, 2);
    } finally {
        f.close();
    }
});
await test('readiness loss discards unclaimed preparation and cleanup failure is retried before re-preparation', async () => {
    const f = fixture();
    let ready = true,
        prepares = 0,
        discards = 0,
        sends = 0;
    try {
        f.store.media.prepare(f.request('$file'));
        const dispatcher = new MediaDispatcher({
            profile: f.profile,
            journal: f.store.media,
            ready: () => ready,
            authorize: async () => {},
            prepare: async (r) => {
                prepares++;
                if (prepares === 1) ready = false;
                return {
                    request: sendRequest(r),
                    discard: async () => {
                        discards++;
                        if (discards === 1) throw new Error('temporary');
                    },
                };
            },
            backend: {
                sendPreparedFile: async (_r, persist) => {
                    sends++;
                    const ids = ['m:0100000000000000'];
                    await persist(ids);
                    return ids;
                },
            },
        });
        await assert.rejects(dispatcher.drain());
        assert.equal(sends, 0);
        assert.equal(prepares, 1);
        assert.equal(discards, 1);
        assert.equal(f.store.media.get(f.profile, '$file')!.state, 'PREPARED');
        ready = true;
        assert.equal(await dispatcher.drain(), 1);
        assert.equal(discards, 2);
        assert.equal(prepares, 2);
        assert.equal(sends, 1);
    } finally {
        f.close();
    }
});

await test('authorization is checked again after preparation before a durable dispatch claim', async () => {
    const f = fixture();
    let checks = 0,
        discards = 0;
    try {
        f.store.media.prepare(f.request('$file'));
        const dispatcher = new MediaDispatcher({
            profile: f.profile,
            journal: f.store.media,
            ready: () => true,
            authorize: async () => {
                if (++checks === 2) throw new Error('membership changed');
            },
            prepare: async (r) => ({
                request: sendRequest(r),
                discard: async () => {
                    discards++;
                },
            }),
            backend: {
                sendPreparedFile: async () => {
                    assert.fail('Send must remain gated');
                },
            },
        });
        await assert.rejects(dispatcher.drain());
        assert.equal(checks, 2);
        assert.equal(discards, 1);
        assert.equal(f.store.media.get(f.profile, '$file')!.state, 'PREPARED');
    } finally {
        f.close();
    }
});

await test('image dispatch persists canonical metadata before send and never retries an uncertain image', async () => {
    const f = fixture();
    const image = f.request('$image');
    image.media.kind = 'm.image';
    const projection = {
        kind: 'image' as const,
        fileName: 'canonical.png',
        mediaType: 'image/png' as const,
        bytes: 100,
        width: 16,
        height: 8,
        thumbnailMediaType: 'image/png' as const,
        thumbnailBytes: 40,
        thumbnailWidth: 8,
        thumbnailHeight: 4,
    };
    let sends = 0,
        mismatch = true,
        thumbnailMismatch = false,
        discarded = 0;
    const dispatcher = new MediaDispatcher({
        profile: f.profile,
        journal: f.store.media,
        ready: () => true,
        authorize: async () => {},
        prepare: async () => {
            throw new Error('Wrong preparation route');
        },
        backend: {
            sendPreparedFile: async () => {
                throw new Error('Wrong send route');
            },
        },
        images: {
            prepare: async () => ({
                request: {
                    profile: f.profile,
                    chatId: image.media.chat,
                    token: 'a'.repeat(64),
                    thumbnailToken: 'b'.repeat(64),
                    mediaType: 'image/png',
                    thumbnailMediaType: 'image/png' as const,
                    fileName: 'canonical.png',
                    width: 16,
                    height: 8,
                    thumbnailWidth: 8,
                    thumbnailHeight: 4,
                },
                projection: {
                    ...projection,
                    width: mismatch ? 17 : 16,
                    thumbnailMediaType: thumbnailMismatch ? 'image/jpeg' : 'image/png',
                },
                discard: async () => {
                    discarded++;
                },
            }),
            send: async (_command, persist) => {
                sends++;
                assert.deepEqual(f.store.media.imageProjection(f.profile, image.event), projection);
                await persist(['m:0100000000000000']);
                throw new Error('synthetic lost image send response');
            },
        },
    });
    try {
        f.store.media.prepare(image);
        await assert.rejects(dispatcher.drain());
        assert.equal(discarded, 1);
        assert.equal(f.store.media.get(f.profile, image.event)!.state, 'PREPARED');
        assert.equal(f.store.media.imageProjection(f.profile, image.event), undefined);
        mismatch = false;
        thumbnailMismatch = true;
        await assert.rejects(dispatcher.drain());
        assert.equal(sends, 0);
        assert.equal(discarded, 2);
        assert.equal(f.store.media.get(f.profile, image.event)!.state, 'PREPARED');
        thumbnailMismatch = false;
        await assert.rejects(dispatcher.drain());
        assert.equal(sends, 1);
        assert.equal(discarded, 2, 'A send attempt may have transferred both handles');
        assert.equal(f.store.media.get(f.profile, image.event)!.state, 'OUTCOME_UNKNOWN');
        assert.deepEqual(f.store.media.get(f.profile, image.event)!.ids, ['m:0100000000000000']);
        assert.equal(await dispatcher.drain(), 0);
        assert.equal(sends, 1);
    } finally {
        f.close();
    }
});
