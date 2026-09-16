import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {MutationIngress} from '../src/outbox/mutation-ingress.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('image caption edits preserve prepared geometry and owner mapping across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'image-mutation-')),
        key = randomBytes(32);
    const filename = join(directory, 'outbox');
    let outbox = new OutboxStore(filename, key);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key),
        portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234',
        messageId = 'm:0100000000000000';
    const file = {
        url: 'mxc://invalid/image',
        v: 'v2' as const,
        key: {
            kty: 'oct' as const,
            alg: 'A256CTR' as const,
            key_ops: ['decrypt'],
            k: Buffer.alloc(32).toString('base64url'),
        },
        iv: Buffer.alloc(16).toString('base64'),
        hashes: {sha256: Buffer.alloc(32).toString('base64')},
    };
    const content = {
        msgtype: 'm.image',
        body: 'source.png',
        filename: 'source.png',
        file,
        info: {w: 1000, h: 500},
    };
    const base = {sender: owner, room_id: room, type: 'm.room.message', encrypted: true};
    const echo: NormalizedNodeMessage = {
        direction: 'outbound',
        senderIdentity: profile,
        chatId: chat,
        messageId,
        createdAt: new Date(1),
        sentAt: new Date(1),
        ordinal: 1n,
        reactions: [],
        content: {
            type: 'image',
            fileName: 'prepared.jpg',
            mimeType: 'image/jpeg',
            byteSize: 100,
            dimensions: {width: 800, height: 400},
            thumbnailMimeType: 'image/jpeg',
        },
    };
    try {
        portals.bind(profile, chat, room);
        outbox.media.prepare({
            id: createRequestId(),
            profile,
            owner,
            room,
            event: '$image',
            transaction: 'image',
            media: {
                chat,
                kind: 'm.image',
                filename: 'source.png',
                mimeType: 'image/png',
                bytes: 12,
                file,
            },
        });
        assert(outbox.media.claim(profile, '$image'));
        outbox.media.recordImageProjection(profile, '$image', {
            kind: 'image',
            fileName: 'prepared.jpg',
            mediaType: 'image/jpeg',
            bytes: 100,
            width: 800,
            height: 400,
            thumbnailMediaType: 'image/jpeg',
            thumbnailBytes: 20,
            thumbnailWidth: 400,
            thumbnailHeight: 200,
        });
        outbox.media.recordIds(profile, '$image', [messageId]);
        assert(reconcileOutboundEcho(outbox, portals, profile, owner, echo));
        for (const [event, caption] of [
            ['$edit', 'new caption'],
            ['$remove', ''],
        ] as const) {
            inbox.accept(event, {});
            inbox.complete(event, [
                {
                    ...base,
                    event_id: event,
                    content: {
                        'm.relates_to': {rel_type: 'm.replace', event_id: '$image'},
                        'm.new_content': {...content, body: caption || content.filename},
                    },
                },
            ]);
            const ingress = new MutationIngress({
                profile,
                owner,
                inbox,
                outbox,
                portals,
                original: async () => ({...base, event_id: '$image', content}),
            });
            assert.equal(await ingress.drain(), 1);
            const changed = {...echo, content: {...echo.content, caption}} as NormalizedNodeMessage;
            if (caption)
                assert.throws(() =>
                    reconcileOutboundEcho(outbox, portals, profile, owner, changed),
                );
            assert(outbox.mutations.claim(profile, event, 0));
            outbox.close();
            outbox = new OutboxStore(filename, key);
            outbox.recoverInterrupted();
            assert(reconcileOutboundEcho(outbox, portals, profile, owner, changed));
            assert.equal(
                reconcileOutboundEcho(
                    outbox,
                    portals,
                    profile,
                    owner,
                    {
                        ...changed,
                        content: {...echo.content, caption: 'independent phone caption'},
                    } as NormalizedNodeMessage,
                    true,
                    true,
                ),
                false,
            );
            for (const change of [
                {fileName: 'other.jpg'},
                {mimeType: 'image/png'},
                {byteSize: 101},
                {dimensions: {width: 801, height: 400}},
                {thumbnailMimeType: 'image/png'},
                {type: 'file'},
            ]) {
                assert.throws(() =>
                    reconcileOutboundEcho(
                        outbox,
                        portals,
                        profile,
                        owner,
                        {
                            ...changed,
                            content: {...changed.content, ...change},
                        } as NormalizedNodeMessage,
                        true,
                        true,
                    ),
                );
            }
            assert(outbox.mutations.observeDesiredState(profile, event, 0, true));
            assert.equal(portals.messageMapping(profile, chat, messageId)?.root, '$image');
        }
    } finally {
        outbox.close();
        inbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
