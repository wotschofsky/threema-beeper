import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
for (const locallyAccepted of [false, true]) {
    await test(`Local model echo preserves uncertain delivery after restart (accepted=${locallyAccepted})`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-echo-repro-')),
            key = randomBytes(32);
        let outbox = new OutboxStore(join(directory, 'outbox'), key);
        const portals = new PortalStore(join(directory, 'portals'), key);
        try {
            const value = {
                requestId: '01900000-0000-7000-8000-000000000001',
                profile: 'SELF1234',
                transactionId: 'fixture',
                eventId: '$fixture',
                roomId: '!fixture:invalid',
                sender: '@owner:invalid',
                chatId: 'c:TEST1234',
                text: 'fixture',
            };
            const messageId = 'm:0100000000000000';
            portals.bind(value.profile, value.chatId, value.roomId);
            outbox.prepare(value);
            outbox.claim(value.requestId);
            outbox.recordIds(value.requestId, [messageId]);
            if (locallyAccepted) outbox.sent(value.requestId, [messageId]);
            outbox.close();
            outbox = new OutboxStore(join(directory, 'outbox'), key);
            outbox.recoverInterrupted();
            assert.equal(outbox.get(value.requestId)?.state, 'OUTCOME_UNKNOWN');
            assert.equal(outbox.recoveryItems(value.profile).length, 1);
            reconcileOutboundEcho(outbox, portals, value.profile, value.sender, {
                direction: 'outbound',
                senderIdentity: value.profile,
                chatId: value.chatId,
                messageId,
                createdAt: new Date(0),
                ordinal: 1n,
                reactions: [],
                content: {type: 'text', text: value.text},
            });
            const state = outbox.get(value.requestId)?.state,
                after = outbox.recoveryItems(value.profile).length;
            assert.equal(state, 'OUTCOME_UNKNOWN');
            assert.equal(after, 1);
            reconcileOutboundEcho(outbox, portals, value.profile, value.sender, {
                direction: 'outbound',
                senderIdentity: value.profile,
                chatId: value.chatId,
                messageId,
                createdAt: new Date(0),
                sentAt: new Date(1000),
                ordinal: 1n,
                reactions: [],
                content: {type: 'text', text: value.text},
            });
            assert.equal(outbox.get(value.requestId)?.state, 'ACKED');
            outbox.close();
            outbox = new OutboxStore(join(directory, 'outbox'), key);
            outbox.recoverInterrupted();
            assert.equal(outbox.get(value.requestId)?.state, 'ACKED');
            assert.equal(outbox.recoveryItems(value.profile).length, 0);
        } finally {
            outbox.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });

    await test(`Local file echo retains uncertainty after restart (accepted=${locallyAccepted})`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-file-echo-')),
            key = randomBytes(32);
        let outbox = new OutboxStore(join(directory, 'outbox'), key);
        const portals = new PortalStore(join(directory, 'portals'), key);
        try {
            const profile = 'SELF1234',
                owner = '@owner:invalid',
                chat = 'c:TEST1234',
                room = '!file:invalid',
                event = '$file',
                messageId = 'm:0200000000000000';
            const request: import('../src/outbox/media-journal.ts').MediaRequest = {
                id: '01900000-0000-7000-8000-000000000002',
                profile,
                owner,
                room,
                event,
                transaction: 'fixture',
                media: {
                    chat,
                    kind: 'm.file',
                    filename: 'fixture.bin',
                    mimeType: 'application/octet-stream',
                    bytes: 3,
                    file: {
                        url: 'mxc://invalid/fixture',
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
            portals.bind(profile, chat, room);
            outbox.media.prepare(request);
            outbox.media.claim(profile, event);
            outbox.media.recordIds(profile, event, [messageId]);
            if (locallyAccepted) outbox.media.sent(profile, event, [messageId]);
            outbox.close();
            outbox = new OutboxStore(join(directory, 'outbox'), key);
            outbox.recoverInterrupted();
            const echo: import('../src/threema/history.ts').NormalizedNodeMessage = {
                direction: 'outbound',
                senderIdentity: profile,
                chatId: chat,
                messageId,
                createdAt: new Date(0),
                ordinal: 1n,
                reactions: [],
                content: {
                    type: 'file',
                    fileName: 'fixture.bin',
                    mimeType: 'application/octet-stream',
                    byteSize: 3,
                },
            };
            assert(reconcileOutboundEcho(outbox, portals, profile, owner, echo));
            assert.equal(outbox.media.get(profile, event)?.state, 'OUTCOME_UNKNOWN');
            assert.equal(outbox.recoveryItems(profile).length, 1);
            assert.equal(outbox.media.next(profile), undefined);
            assert.equal(portals.messageMapping(profile, chat, messageId)?.root, event);
            assert(
                reconcileOutboundEcho(outbox, portals, profile, owner, {
                    ...echo,
                    deliveredAt: new Date(1000),
                }),
            );
            assert.equal(outbox.media.get(profile, event)?.state, 'SENT');
            outbox.close();
            outbox = new OutboxStore(join(directory, 'outbox'), key);
            outbox.recoverInterrupted();
            assert.equal(outbox.media.get(profile, event)?.state, 'SENT');
            assert.equal(outbox.recoveryItems(profile).length, 0);
        } finally {
            outbox.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
}
