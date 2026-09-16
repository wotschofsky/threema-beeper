import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
import {renderMetrics} from '../src/service/metrics.ts';
import {parseImageProjection} from '../src/outbox/image-projection.ts';
for (const [imageType, thumbnailType] of [
    ['image/png', 'image/png'],
    ['image/jpeg', 'image/jpeg'],
    ['image/gif', 'image/jpeg'],
    ['image/webp', 'image/jpeg'],
    ['image/png', 'image/jpeg'],
] as const)
    await test(`media journal retains uncertain IDs across restart and prevents event/ID reclassification (${imageType}/${thumbnailType})`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'media-journal-')),
            key = randomBytes(32),
            filename = join(directory, 'outbox');
        let store = new OutboxStore(filename, key);
        const portals = new PortalStore(join(directory, 'portals'), key);
        const request: MediaRequest = {
            id: createRequestId(),
            profile: 'SELF1234',
            event: '$media',
            room: '!room:invalid',
            owner: '@owner:invalid',
            transaction: 'transaction',
            media: {
                chat: 'c:ABCD1234',
                kind: 'm.file',
                filename: 'fixture.bin',
                mimeType: 'application/octet-stream',
                bytes: 3,
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
        try {
            store.media.prepare(request);
            assert.deepEqual(store.media.pendingCounts(request.profile), {
                prepared: 1,
                dispatching: 0,
                awaitingEcho: 0,
                uncertain: 0,
            });
            assert.deepEqual(store.media.pendingCounts('OTHER123'), {
                prepared: 0,
                dispatching: 0,
                awaitingEcho: 0,
                uncertain: 0,
            });
            store.media.prepare({...request, id: createRequestId()});
            assert.equal(store.media.get(request.profile, request.event)!.request.id, request.id);
            assert.throws(() =>
                store.media.prepare({...request, media: {...request.media, caption: 'changed'}}),
            );
            assert.throws(() =>
                store.rejectEvent(request.profile, request.event, request.room, 'unsupported'),
            );
            const text = {
                requestId: createRequestId(),
                profile: request.profile,
                eventId: request.event,
                roomId: request.room,
                sender: request.owner,
                transactionId: 'transaction',
                chatId: request.media.chat,
                text: 'text',
            };
            assert.throws(() => store.prepare(text));
            assert.throws(() =>
                store.reactions.prepare({
                    profile: request.profile,
                    event: request.event,
                    room: request.room,
                    owner: request.owner,
                    chat: request.media.chat,
                    target: '$target',
                    emoji: '👍',
                    action: 'apply',
                    messages: ['m:0100000000000000'],
                }),
            );
            assert.equal(store.media.claim(request.profile, request.event), true);
            assert.equal(store.media.pendingCounts(request.profile).dispatching, 1);
            const ids = ['m:0100000000000000'];
            assert.throws(() => store.media.sent(request.profile, request.event, ids));
            store.media.recordIds(request.profile, request.event, ids);
            store.prepare({...text, eventId: '$text'});
            store.claim(text.requestId);
            assert.throws(() => store.recordIds(text.requestId, ids));
            store.close();
            // Reconstruct schema 7 while retaining the real encrypted media rows and IDs.
            const legacy = new Database(filename);
            try {
                legacy.pragma('cipher_compatibility = 4');
                legacy.pragma(`key = "x'${key.toString('hex')}'"`);
                legacy.pragma('cipher_log_level = NONE');
                legacy.exec('ALTER TABLE media_parts DROP COLUMN observed; PRAGMA user_version=7;');
            } finally {
                legacy.close();
            }
            store = new OutboxStore(filename, key);
            store.recoverInterrupted();
            assert.deepEqual(store.media.get(request.profile, request.event)!.ids, ids);
            assert.equal(store.media.get(request.profile, request.event)!.state, 'OUTCOME_UNKNOWN');
            assert.deepEqual(store.media.pendingCounts(request.profile), {
                prepared: 0,
                dispatching: 0,
                awaitingEcho: 0,
                uncertain: 1,
            });
            assert.equal(store.media.claim(request.profile, request.event), false);
            store.media.prepare({...request, id: createRequestId(), event: '$later'});
            assert.equal(store.media.next(request.profile), undefined);
            const other = {
                ...request,
                id: createRequestId(),
                event: '$other',
                room: '!other:invalid',
                media: {...request.media, chat: 'c:OTHER123'},
            };
            store.media.prepare(other);
            assert.equal(store.media.claim(other.profile, other.event), true);
            store.media.recordIds(other.profile, other.event, ['m:0200000000000000']);
            store.media.sent(other.profile, other.event, ['m:0200000000000000']);
            assert.equal(store.media.get(other.profile, other.event)!.state, 'SENT');
            const counts = store.media.pendingCounts(request.profile);
            assert.deepEqual(counts, {prepared: 1, dispatching: 0, awaitingEcho: 1, uncertain: 1});
            const snapshot = {
                live: true,
                ready: true,
                syncLive: true,
                uptimeSeconds: 0,
                residentBytes: 1,
                mediaQueues: counts,
            };
            const metrics = renderMetrics(snapshot);
            assert(metrics.includes('bridge_media_awaiting_echo 1\n'));
            assert(metrics.includes('bridge_media_uncertain 1\n'));
            assert(!metrics.includes(request.profile));
            assert(!metrics.includes(request.media.filename));
            for (const invalid of [-1, NaN, Infinity, 0.5])
                assert.throws(() =>
                    renderMetrics({...snapshot, mediaQueues: {...counts, prepared: invalid}}),
                );
            portals.bind(request.profile, request.media.chat, request.room);
            const echo: NormalizedNodeMessage = {
                messageId: ids[0]!,
                chatId: request.media.chat,
                direction: 'outbound',
                senderIdentity: request.profile,
                createdAt: new Date(0),
                sentAt: new Date(0),
                ordinal: 1n,
                reactions: [],
                content: {
                    type: 'file',
                    mimeType: request.media.mimeType,
                    fileName: request.media.filename,
                    byteSize: 3,
                },
            };
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                    ...echo,
                    senderIdentity: 'OTHER123',
                }),
            );
            assert.throws(() =>
                reconcileOutboundEcho(store, portals, request.profile, request.owner, {
                    ...echo,
                    content: {
                        ...echo.content,
                        type: 'file',
                        mimeType: 'application/octet-stream',
                        byteSize: 4,
                    },
                }),
            );
            assert.equal(store.media.get(request.profile, request.event)!.state, 'OUTCOME_UNKNOWN');
            assert.equal(
                reconcileOutboundEcho(store, portals, request.profile, request.owner, echo),
                true,
            );
            assert.equal(store.media.get(request.profile, request.event)!.state, 'SENT');
            assert.equal(
                portals.messageForEvent(request.profile, request.media.chat, request.event),
                ids[0],
            );
            // A late send failure/response must not undo the stronger already-persisted echo evidence.
            store.media.unknown(request.profile, request.event);
            store.media.sent(request.profile, request.event, ids);
            assert.equal(
                reconcileOutboundEcho(store, portals, request.profile, request.owner, echo),
                true,
            );
            assert.equal(store.media.next(request.profile)!.request.event, '$later');
            assert.equal(store.media.pendingCounts(request.profile).uncertain, 0);
            store.media.observe(other.profile, other.media.chat, 'm:0200000000000000');
            assert.equal(store.media.pendingCounts(request.profile).awaitingEcho, 0);
            const imageRequest = {
                ...request,
                id: createRequestId(),
                profile: 'OTHER123',
                event: '$image',
                room: '!image:invalid',
                media: {...request.media, kind: 'm.image' as const},
            };
            store.media.prepare(imageRequest);
            store.close();
            const schema8 = new Database(filename);
            try {
                schema8.pragma('cipher_compatibility = 4');
                schema8.pragma(`key = "x'${key.toString('hex')}'"`);
                schema8.pragma('cipher_log_level = NONE');
                schema8.exec('DROP TABLE media_image_projections; PRAGMA user_version=8;');
            } finally {
                schema8.close();
            }
            store = new OutboxStore(filename, key);
            assert.equal(store.media.get(imageRequest.profile, '$image')!.state, 'PREPARED');
            const projection = parseImageProjection({
                kind: 'image',
                fileName: 'canonical.png',
                mediaType: imageType,
                bytes: 123,
                width: 16,
                height: 8,
                thumbnailMediaType: thumbnailType,
                thumbnailBytes: 64,
                thumbnailWidth: 8,
                thumbnailHeight: 4,
            });
            assert.throws(() =>
                store.media.recordImageProjection(imageRequest.profile, '$image', projection),
            );
            store.media.claim(imageRequest.profile, '$image');
            assert.throws(() =>
                store.media.recordIds(imageRequest.profile, '$image', ['m:0300000000000000']),
            );
            assert.throws(() => parseImageProjection({...projection, token: 'secret-token'}));
            assert.throws(() =>
                parseImageProjection({...projection, thumbnailMediaType: 'image/avif'}),
            );
            assert.equal(
                parseImageProjection({...projection, width: 1, height: 1}).thumbnailWidth,
                8,
            );
            assert.throws(() => parseImageProjection({...projection, thumbnailWidth: 513}));
            store.media.recordImageProjection(imageRequest.profile, '$image', projection);
            store.media.recordImageProjection(imageRequest.profile, '$image', {...projection});
            assert.throws(() =>
                store.media.recordImageProjection(imageRequest.profile, '$image', {
                    ...projection,
                    bytes: 124,
                }),
            );
            store.media.recordIds(imageRequest.profile, '$image', ['m:0300000000000000']);
            store.close();
            if (!(imageType === 'image/png' && thumbnailType === 'image/jpeg')) {
                const legacy9 = new Database(filename);
                try {
                    legacy9.pragma('cipher_compatibility = 4');
                    legacy9.pragma(`key = "x'${key.toString('hex')}'"`);
                    legacy9.pragma('cipher_log_level = NONE');
                    const {thumbnailMediaType: _omitted, ...oldProjection} = projection;
                    legacy9
                        .prepare('UPDATE media_image_projections SET body=? WHERE request=?')
                        .run(JSON.stringify(oldProjection), imageRequest.id);
                    legacy9.exec('PRAGMA user_version=9;');
                } finally {
                    legacy9.close();
                }
            }

            store = new OutboxStore(filename, key);
            store.recoverInterrupted();
            assert.deepEqual(
                store.media.imageProjection(imageRequest.profile, '$image'),
                projection,
            );
            assert.equal(store.media.imageProjection(request.profile, '$image'), undefined);
            assert.equal(store.media.get(imageRequest.profile, '$image')!.state, 'OUTCOME_UNKNOWN');
            portals.bind(imageRequest.profile, imageRequest.media.chat, imageRequest.room);
            const imageEcho: NormalizedNodeMessage = {
                ...echo,
                senderIdentity: imageRequest.profile,
                messageId: 'm:0300000000000000',
                content: {
                    type: 'image',
                    fileName: projection.fileName,
                    mimeType: projection.mediaType,
                    byteSize: projection.bytes,
                    dimensions: {width: projection.width, height: projection.height},
                    thumbnailMimeType: thumbnailType,
                },
            };
            for (const difference of [
                {byteSize: 124},
                {dimensions: {width: 17, height: 8}},
                {mimeType: imageType === 'image/png' ? 'image/jpeg' : 'image/png'},
                {thumbnailMimeType: thumbnailType === 'image/png' ? 'image/jpeg' : 'image/png'},
                {fileName: 'different.png'},
                {caption: 'different'},
            ]) {
                assert.throws(() =>
                    reconcileOutboundEcho(
                        store,
                        portals,
                        imageRequest.profile,
                        imageRequest.owner,
                        {
                            ...imageEcho,
                            content: {
                                ...imageEcho.content,
                                ...difference,
                            } as typeof imageEcho.content,
                        },
                    ),
                );
                assert.equal(
                    store.media.get(imageRequest.profile, '$image')!.state,
                    'OUTCOME_UNKNOWN',
                );
            }
            assert.equal(
                reconcileOutboundEcho(
                    store,
                    portals,
                    imageRequest.profile,
                    imageRequest.owner,
                    imageEcho,
                ),
                true,
            );
            assert.equal(store.media.get(imageRequest.profile, '$image')!.state, 'SENT');
            assert.equal(
                portals.messageForEvent(imageRequest.profile, imageRequest.media.chat, '$image'),
                imageEcho.messageId,
            );
            assert.equal(
                reconcileOutboundEcho(
                    store,
                    portals,
                    imageRequest.profile,
                    imageRequest.owner,
                    imageEcho,
                ),
                true,
            );
        } finally {
            portals.close();
            store.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
