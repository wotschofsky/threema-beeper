import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import {parseVideoProjection} from '../src/outbox/video-projection.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

for (const mode of ['video', 'thumbnail', 'file'] as const)
    await test(`video ${mode} preserves canonical output across uncertain restart`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'fallback-outbox-')),
            key = randomBytes(32);
        const filename = join(directory, 'outbox');
        let store = new OutboxStore(filename, key);
        const portals = new PortalStore(join(directory, 'portals'), key);
        const request: MediaRequest = {
            id: createRequestId(),
            profile: 'SELF1234',
            event: '$fallback',
            room: '!room:invalid',
            owner: '@owner:invalid',
            transaction: 'fallback',
            media: {
                chat: 'c:ABCD1234',
                kind: 'm.video',
                filename: 'original.mov',
                mimeType: 'video/quicktime',
                bytes: 12,
                file: {
                    url: 'mxc://invalid/file',
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
        const projection = parseVideoProjection({
            kind: mode === 'file' ? 'file' : 'video',
            fileName: mode === 'file' ? 'original.mov' : 'prepared.mp4',
            mediaType: mode === 'file' ? 'video/quicktime' : 'video/mp4',
            bytes: 1234,
            caption: 'caption',
            ...(mode === 'file' ? {} : {durationSeconds: 1.25, width: 640, height: 360}),
            ...(mode === 'thumbnail'
                ? {
                      thumbnailMediaType: 'image/jpeg',
                      thumbnailBytes: 100,
                      thumbnailWidth: 320,
                      thumbnailHeight: 180,
                  }
                : {}),
        });
        let invalidDuration = true,
            sends = 0,
            discards = 0;
        const send = async (
            persist: (ids: readonly string[]) => Promise<void>,
        ): Promise<readonly string[]> => {
            assert.deepEqual(
                store.media.videoProjection(request.profile, request.event),
                projection,
            );
            assert.throws(() =>
                store.media.recordVideoProjection(request.profile, request.event, {
                    ...projection,
                    bytes: 42,
                }),
            );
            sends++;
            await persist(['m:0100000000000000']);
            throw new Error('Unknown after allocation');
        };
        try {
            assert.throws(() => parseVideoProjection({...projection, durationSeconds: -1}));
            assert.throws(() => parseVideoProjection({...projection, token: 'a'.repeat(64)}));
            store.media.prepare(request);
            store.close();
            const legacy = new Database(filename);
            try {
                legacy.pragma('cipher_compatibility = 4');
                legacy.pragma(`key = "x'${key.toString('hex')}'"`);
                legacy.pragma('cipher_log_level = NONE');
                legacy.exec('DROP TABLE media_video_projections; PRAGMA user_version=12;');
            } finally {
                legacy.close();
            }
            store = new OutboxStore(filename, key);
            assert.equal(store.media.get(request.profile, request.event)?.state, 'PREPARED');
            portals.bind(request.profile, request.media.chat, request.room);
            const dispatcher = new MediaDispatcher({
                profile: request.profile,
                journal: store.media,
                ready: () => true,
                authorize: async () => {},
                prepare: async () => {
                    throw new Error('Wrong route');
                },
                videos: {
                    send: async (command, persist) => send(persist),
                    prepare: async () => ({
                        projection,
                        request: {
                            profile: request.profile,
                            chatId: request.media.chat,
                            token: 'a'.repeat(64),
                            fileName: projection.fileName,
                            mediaType: projection.mediaType,
                            caption: projection.caption,
                            ...(projection.kind === 'video'
                                ? {
                                      durationSeconds: projection.durationSeconds,
                                      width: projection.width,
                                      height: projection.height,
                                  }
                                : {}),
                            ...(projection.kind === 'video' && projection.thumbnailMediaType
                                ? {
                                      thumbnailToken: 'b'.repeat(64),
                                      thumbnailMediaType: projection.thumbnailMediaType,
                                      thumbnailWidth: projection.thumbnailWidth,
                                      thumbnailHeight: projection.thumbnailHeight,
                                  }
                                : {}),
                            ...(invalidDuration ? {fileName: 'conflict.mp4'} : {}),
                        },
                        discard: async () => {
                            discards++;
                        },
                    }),
                },
                backend: {
                    sendPreparedFile: async (command, persist) => {
                        assert.equal(mode, 'file');
                        return send(persist);
                    },
                },
            });
            await assert.rejects(dispatcher.drain());
            assert.equal(sends, 0);
            assert.equal(discards, 1);
            invalidDuration = false;
            assert.equal(await dispatcher.drain(), 0); // Preparation failures respect retry backoff.
            assert.equal(store.retryPrepared(request.profile), 1);
            await assert.rejects(dispatcher.drain());
            assert.equal(sends, 1);
            store.close();
            store = new OutboxStore(filename, key);
            store.recoverInterrupted();
            assert.equal(store.media.get(request.profile, request.event)?.state, 'OUTCOME_UNKNOWN');
            assert.deepEqual(
                store.media.videoProjection(request.profile, request.event),
                projection,
            );
            assert.equal(store.media.next(request.profile), undefined);
            const echo: NormalizedNodeMessage = {
                direction: 'outbound',
                senderIdentity: request.profile,
                chatId: request.media.chat,
                messageId: 'm:0100000000000000',
                createdAt: new Date(1),
                sentAt: new Date(1),
                ordinal: 1n,
                reactions: [],
                content: {
                    type: projection.kind,
                    fileName: projection.fileName,
                    mimeType: projection.mediaType,
                    byteSize: projection.bytes,
                    caption: projection.caption,
                    ...(projection.kind === 'video'
                        ? {
                              durationSeconds: projection.durationSeconds,
                              dimensions: {width: projection.width, height: projection.height},
                              ...(projection.thumbnailMediaType
                                  ? {thumbnailMimeType: projection.thumbnailMediaType}
                                  : {}),
                          }
                        : {}),
                },
            };
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                    ...echo,
                    content: {...echo.content, byteSize: 4321},
                } as NormalizedNodeMessage),
            );
            if (projection.kind === 'video') {
                for (const mutation of [
                    {durationSeconds: 2},
                    {dimensions: {width: 1, height: 1}},
                    {thumbnailMimeType: 'image/webp'},
                    {type: 'file'},
                ]) {
                    assert.throws(() =>
                        reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                            ...echo,
                            content: {...echo.content, ...mutation},
                        } as NormalizedNodeMessage),
                    );
                    assert.equal(
                        store.media.get(request.profile, request.event)?.state,
                        'OUTCOME_UNKNOWN',
                    );
                }
            }
            assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, echo));
            const edit = {
                profile: request.profile,
                owner: request.owner,
                room: request.room,
                chat: request.media.chat,
                event: '$caption-edit',
                target: request.event,
                commands: [
                    {
                        profile: request.profile,
                        chatId: request.media.chat,
                        messageId: echo.messageId,
                        action: 'edit' as const,
                        text: 'changed caption',
                    },
                ],
            };
            const changed = {
                ...echo,
                content: {...echo.content, caption: 'changed caption'},
            } as NormalizedNodeMessage;
            store.mutations.prepare(edit);
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, changed),
            );
            assert(store.mutations.claim(request.profile, edit.event, 0));
            assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, changed));
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                    ...changed,
                    content: {...changed.content, byteSize: 4321},
                } as NormalizedNodeMessage),
            );
            store.mutations.finish(request.profile, edit.event, 0, 'APPLIED');
            const removal = {
                ...edit,
                event: '$caption-remove',
                commands: [{...edit.commands[0]!, text: ''}],
            };
            store.mutations.prepare(removal);
            assert(store.mutations.claim(request.profile, removal.event, 0));
            const removed = {...echo, content: {...echo.content}} as NormalizedNodeMessage;
            delete (removed.content as {caption?: string}).caption;
            assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, removed));
            assert.equal(
                portals.messageMapping(request.profile, request.media.chat, echo.messageId)?.root,
                request.event,
            );
            assert.equal(store.media.get(request.profile, request.event)?.state, 'SENT');
            assert.equal(
                portals.messageForEvent(request.profile, request.media.chat, request.event),
                echo.messageId,
            );
            assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, echo));
            assert.equal(sends, 1);
        } finally {
            store.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });

await test('video projection rejects invalid bounds, partial thumbnails and secrets', () => {
    const valid = {
        kind: 'video',
        fileName: 'test.mp4',
        mediaType: 'video/mp4',
        bytes: 10,
        durationSeconds: 1,
        width: 640,
        height: 360,
    };
    for (const change of [
        {bytes: 0},
        {bytes: 1024 ** 3 + 1},
        {durationSeconds: NaN},
        {durationSeconds: Infinity},
        {width: 8193},
        {height: 0},
        {fileName: '../test'},
        {thumbnailMediaType: 'image/jpeg'},
        {token: 'a'.repeat(64)},
        {key: 'secret'},
        {audioDurationSeconds: 1},
    ])
        assert.throws(() => parseVideoProjection({...valid, ...change}));
    const thumbnail = {
        ...valid,
        thumbnailMediaType: 'image/png',
        thumbnailBytes: 1,
        thumbnailWidth: 512,
        thumbnailHeight: 512,
    };
    assert.deepEqual(parseVideoProjection(thumbnail), thumbnail);
    for (const change of [{thumbnailWidth: 513}, {thumbnailBytes: 0}, {thumbnailBytes: undefined}])
        assert.throws(() => parseVideoProjection({...thumbnail, ...change}));
    assert.deepEqual(parseVideoProjection(valid), valid);
});
