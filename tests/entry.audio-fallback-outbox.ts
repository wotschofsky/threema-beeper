import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import {parseAudioProjection} from '../src/outbox/audio-projection.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

for (const mime of ['audio/mp4', 'audio/flac'])
    await test(`audio fallback ${mime} persists file kind across uncertain restart`, async () => {
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
                kind: 'm.audio',
                filename: 'original.flac',
                mimeType: 'audio/flac',
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
        const projection = parseAudioProjection({
            kind: 'file',
            fileName: mime === 'audio/mp4' ? 'threema-fallback.m4a' : 'original.flac',
            mediaType: mime,
            bytes: mime === 'audio/mp4' ? 1234 : 12,
            caption: 'caption',
        });
        let invalidDuration = true,
            sends = 0,
            discards = 0;
        try {
            assert.throws(() => parseAudioProjection({...projection, durationSeconds: 0.25}));
            assert.throws(() => parseAudioProjection({...projection, token: 'a'.repeat(64)}));
            store.media.prepare(request);
            portals.bind(request.profile, request.media.chat, request.room);
            const dispatcher = new MediaDispatcher({
                profile: request.profile,
                journal: store.media,
                ready: () => true,
                authorize: async () => {},
                prepare: async () => {
                    throw new Error('Wrong route');
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
                            ...(invalidDuration ? {audioDurationSeconds: 0.25} : {}),
                        },
                        discard: async () => {
                            discards++;
                        },
                    }),
                },
                backend: {
                    sendPreparedFile: async (command, persist) => {
                        assert.equal(command.audioDurationSeconds, undefined);
                        assert.deepEqual(
                            store.media.audioProjection(request.profile, request.event),
                            projection,
                        );
                        sends++;
                        await persist(['m:0100000000000000']);
                        throw new Error('Unknown after allocation');
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
                store.media.audioProjection(request.profile, request.event),
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
                    type: 'file',
                    fileName: projection.fileName,
                    mimeType: projection.mediaType,
                    byteSize: projection.bytes,
                    caption: projection.caption,
                },
            };
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                    ...echo,
                    content: {...echo.content, type: 'audio', durationSeconds: 0.25},
                } as NormalizedNodeMessage),
            );
            assert(reconcileOutboundEcho(store, portals, request.profile, request.owner, echo));
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
