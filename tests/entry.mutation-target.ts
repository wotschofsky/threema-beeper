import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {resolveMutationTarget} from '../src/outbox/mutation-target.ts';
await test('edits/deletes wait for confirmed sends, preserve parts and require owner mappings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-target-')),
        key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox'), key),
        portals = new PortalStore(join(directory, 'portals'), key),
        inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    const options = {profile, owner, outbox, portals, inbox};
    const event = {
        event_id: '$edit',
        room_id: room,
        sender: owner,
        type: 'm.room.message',
        encrypted: true,
        content: {
            'm.relates_to': {rel_type: 'm.replace', event_id: '$original'},
            'm.new_content': {msgtype: 'm.text', body: 'Changed'},
        },
    };
    const redaction = {
        ...event,
        event_id: '$delete',
        type: 'm.room.redaction',
        encrypted: false,
        redacts: '$original',
        content: {},
    };
    try {
        portals.bind(profile, chat, room);
        const id = createRequestId();
        outbox.prepare({
            requestId: id,
            profile,
            sender: owner,
            roomId: room,
            chatId: chat,
            eventId: '$original',
            transactionId: 'original',
            text: 'Large original',
        });
        assert.equal(resolveMutationTarget(event, options).kind, 'pending');
        outbox.claim(id);
        const ids = ['m:0100000000000000', 'm:0200000000000000'];
        outbox.recordIds(id, ids);
        outbox.unknown(id);
        assert.equal(resolveMutationTarget(redaction, options).kind, 'pending');
        outbox.observe(profile, chat, ids[0]!);
        assert.equal(resolveMutationTarget(event, options).kind, 'pending');
        outbox.observe(profile, chat, ids[1]!);
        const resolved = resolveMutationTarget(event, options);
        assert.deepEqual(resolved, {
            kind: 'resolved',
            action: 'edit',
            chat,
            target: '$original',
            messages: ids,
            replacement: {msgtype: 'm.text', body: 'Changed'},
        });
        event.content['m.new_content'].body = 'Mutated after resolution';
        assert(resolved.kind === 'resolved' && resolved.action === 'edit');
        assert.equal(resolved.replacement.body, 'Changed');
        assert.deepEqual(resolveMutationTarget(redaction, options), {
            kind: 'resolved',
            action: 'delete',
            chat,
            target: '$original',
            messages: ids,
        });
        assert.equal(resolveMutationTarget({...event, encrypted: false}, options).kind, 'rejected');
        assert.equal(
            resolveMutationTarget({...event, sender: '@other:invalid'}, options).kind,
            'ignore',
        );
        assert.equal(
            resolveMutationTarget({...event, room_id: '!other:invalid'}, options).kind,
            'ignore',
        );
        assert.equal(
            resolveMutationTarget({...redaction, content: {redacts: '$other'}}, options).kind,
            'rejected',
        );
        assert.equal(
            resolveMutationTarget({...redaction, redacts: '$delete'}, options).kind,
            'rejected',
        );
        assert.equal(
            resolveMutationTarget(
                {...redaction, redacts: '$missing'},
                {...options, pendingTarget: () => true},
            ).kind,
            'pending',
        );
        for (const sender of [owner, '@ghost:invalid']) {
            const remote = sender === owner ? 'm:0300000000000000' : 'm:0400000000000000';
            const target = sender === owner ? '$phone' : '$inbound';
            portals.bindOwnerEcho({
                profile,
                chat,
                message: remote,
                room,
                sender,
                root: target,
                latest: target,
                digest: 'a'.repeat(64),
            });
            assert.equal(
                resolveMutationTarget({...redaction, redacts: target}, options).kind,
                sender === owner ? 'resolved' : 'rejected',
            );
        }
        portals.bind(profile, 'c:OTHER123', '!other:invalid');
        assert.equal(
            resolveMutationTarget({...redaction, room_id: '!other:invalid'}, options).kind,
            'rejected',
        );
        const mediaEvent = '$attachment';
        outbox.media.prepare({
            id: createRequestId(),
            profile,
            owner,
            room,
            event: mediaEvent,
            transaction: 'media',
            media: {
                kind: 'm.file',
                chat,
                filename: 'document.bin',
                mimeType: 'application/octet-stream',
                bytes: 3,
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
        });
        const deletion = {...redaction, redacts: mediaEvent};
        assert.equal(resolveMutationTarget(deletion, options).kind, 'pending');
        outbox.media.claim(profile, mediaEvent);
        const mediaIds = ['m:0600000000000000'];
        outbox.media.recordIds(profile, mediaEvent, mediaIds);
        assert.equal(resolveMutationTarget(deletion, options).kind, 'pending');
        outbox.media.sent(profile, mediaEvent, mediaIds);
        assert.deepEqual(resolveMutationTarget(deletion, options), {
            kind: 'resolved',
            action: 'delete',
            chat,
            target: mediaEvent,
            messages: mediaIds,
        });
        inbox.accept('reaction', {});
        inbox.complete('reaction', [
            {
                event_id: '$reaction',
                type: 'm.reaction',
                room_id: room,
                sender: owner,
                encrypted: true,
                content: {},
            },
        ]);
        assert.equal(
            resolveMutationTarget({...redaction, redacts: '$reaction'}, options).kind,
            'ignore',
        );
        inbox.accept('replacement', {});
        inbox.complete('replacement', [{...event, event_id: '$earlier-edit'}]);
        assert.equal(
            resolveMutationTarget({...redaction, redacts: '$earlier-edit'}, options).kind,
            'rejected',
        );
        portals.bindOwnerEcho({
            profile,
            chat,
            message: 'm:0500000000000000',
            room,
            sender: owner,
            root: '$root',
            latest: '$version',
            digest: 'b'.repeat(64),
        });
        assert.equal(
            resolveMutationTarget({...redaction, redacts: '$version'}, options).kind,
            'rejected',
        );
        assert.equal(
            resolveMutationTarget({...redaction, redacts: '$root'}, options).kind,
            'resolved',
        );
        outbox.rejectEvent(profile, event.event_id, room, 'Previous rejection');
        assert.deepEqual(resolveMutationTarget(event, options), {
            kind: 'rejected',
            reason: 'Previous rejection',
        });
    } finally {
        inbox.close();
        portals.close();
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
