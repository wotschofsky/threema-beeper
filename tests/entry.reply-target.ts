import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {MatrixOutboxIngress} from '../src/outbox/matrix-ingress.ts';
import {createRequestId} from '../src/outbox/request-id.ts';

for (const kind of ['text', 'file'] as const)
    await test(`text reply preserves its link to an earlier uncertain ${kind} send`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'reply-target-')),
            key = randomBytes(32);
        const inbox = new TransactionInbox(join(directory, 'inbox'), key);
        const portals = new PortalStore(join(directory, 'portals'), key);
        const outbox = new OutboxStore(join(directory, 'outbox'), key);
        const profile = 'SELF1234',
            owner = '@owner:invalid',
            room = '!room:invalid',
            chat = 'c:ABCD1234';
        const options = {inbox, portals, outbox, profile, owner};
        const id = createRequestId(),
            message = 'm:0100000000000000';
        try {
            portals.bind(profile, chat, room);
            const base = {room_id: room, sender: owner, encrypted: true, type: 'm.room.message'};
            inbox.accept('transaction', {});
            inbox.complete('transaction', [
                {...base, event_id: '$original', content: {msgtype: `m.${kind}`, body: 'original'}},
                {
                    ...base,
                    event_id: '$reply',
                    content: {
                        'msgtype': 'm.text',
                        'body': '> quoted\n\nResponse',
                        'm.relates_to': {'m.in_reply_to': {event_id: '$original'}},
                    },
                },
            ]);
            if (kind === 'text')
                outbox.prepare({
                    requestId: id,
                    profile,
                    sender: owner,
                    roomId: room,
                    chatId: chat,
                    eventId: '$original',
                    transactionId: 'transaction',
                    text: 'original',
                });
            else
                outbox.media.prepare({
                    id,
                    profile,
                    owner,
                    room,
                    event: '$original',
                    transaction: 'transaction',
                    media: {
                        chat,
                        kind: 'm.file',
                        filename: 'original',
                        mimeType: 'application/octet-stream',
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
            inbox.acknowledgeEvent('$original');
            assert.throws(() => new MatrixOutboxIngress(options).drain());
            assert.equal(outbox.forEvent(profile, '$reply'), undefined);
            if (kind === 'text') {
                outbox.claim(id);
                outbox.recordIds(id, [message]);
                outbox.unknown(id);
            } else {
                outbox.media.claim(profile, '$original');
                outbox.media.recordIds(profile, '$original', [message]);
                outbox.media.unknown(profile, '$original');
            }
            portals.bindOwnerEcho({
                profile,
                chat,
                room,
                sender: owner,
                message,
                root: '$original',
                latest: '$original',
                digest: 'a'.repeat(64),
            });
            assert.throws(() => new MatrixOutboxIngress(options).drain());
            if (kind === 'text') outbox.observe(profile, chat, message);
            else outbox.media.observe(profile, chat, message);
            assert.equal(new MatrixOutboxIngress(options).drain(), 1);
            const reply = outbox.forEvent(profile, '$reply')!.request;
            assert.equal(reply.replyTo, message);
            assert.equal(reply.text, 'Response');
            inbox.accept('forward', {});
            inbox.complete('forward', [
                {
                    ...base,
                    event_id: '$forward',
                    content: {
                        'msgtype': 'm.text',
                        'body': 'Forward',
                        'm.relates_to': {'m.in_reply_to': {event_id: '$future'}},
                    },
                },
            ]);
            const acknowledge = inbox.acknowledgeEvent.bind(inbox);
            inbox.acknowledgeEvent = () => {
                throw new Error('synthetic acknowledgement interruption');
            };
            assert.throws(() => new MatrixOutboxIngress(options).drain());
            const fallback = outbox.forEvent(profile, '$forward')!.request;
            assert.equal(fallback.replyTo, undefined);
            portals.bindOwnerEcho({
                profile,
                chat,
                room,
                sender: owner,
                message: 'm:0200000000000000',
                root: '$future',
                latest: '$future',
                digest: 'b'.repeat(64),
            });
            inbox.acknowledgeEvent = acknowledge;
            assert.equal(new MatrixOutboxIngress(options).drain(), 1);
            assert.deepEqual(outbox.forEvent(profile, '$forward')!.request, fallback);
        } finally {
            inbox.close();
            outbox.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
