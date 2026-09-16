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
import {createRequestId} from '../src/outbox/request-id.ts';
await test('mutation ingress persists complete plans before acknowledgement and reuses them after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-ingress-')),
        key = randomBytes(32);
    let inbox = new TransactionInbox(join(directory, 'inbox'), key),
        outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    const base = {sender: owner, room_id: room, encrypted: true, type: 'm.room.message'};
    const original = {
        ...base,
        event_id: '$original',
        content: {msgtype: 'm.text', body: 'Original'},
    };
    const edit = {
        ...base,
        event_id: '$edit',
        content: {
            'msgtype': 'm.text',
            'body': '* shorter',
            'm.relates_to': {rel_type: 'm.replace', event_id: '$original'},
            'm.new_content': {msgtype: 'm.text', body: 'shorter'},
        },
    };
    const ids = ['m:0100000000000000', 'm:0200000000000000'];
    let loads = 0;
    try {
        portals.bind(profile, chat, room);
        const requestId = createRequestId();
        outbox.prepare({
            profile,
            requestId,
            eventId: '$original',
            transactionId: 'original',
            sender: owner,
            roomId: room,
            chatId: chat,
            text: 'Original',
        });
        outbox.claim(requestId);
        outbox.recordIds(requestId, ids);
        outbox.sent(requestId, ids);
        inbox.accept('edit', {});
        inbox.complete('edit', [edit]);
        inbox.acknowledgeEvent = () => {
            throw new Error('Synthetic acknowledgement failure');
        };
        const ingress = new MutationIngress({
            profile,
            owner,
            inbox,
            outbox,
            portals,
            original: async () => {
                loads++;
                return original;
            },
        });
        await assert.rejects(ingress.drain());
        const saved = outbox.mutations.get(profile, '$edit')!;
        assert.equal(loads, 1);
        assert.deepEqual(saved.states, ['PREPARED', 'PREPARED']);
        assert.deepEqual(saved.operation.commands, [
            {profile, chatId: chat, messageId: ids[0], action: 'edit', text: 'shorter'},
            {profile, chatId: chat, messageId: ids[1], action: 'delete'},
        ]);
        inbox.close();
        outbox.close();
        inbox = new TransactionInbox(join(directory, 'inbox'), key);
        outbox = new OutboxStore(join(directory, 'outbox'), key);
        const resumed = new MutationIngress({
            profile,
            owner,
            inbox,
            outbox,
            portals,
            original: async () => {
                assert.fail('A saved plan must not be normalized again');
            },
        });
        assert.equal(await resumed.drain(), 1);
        assert.deepEqual(outbox.mutations.get(profile, '$edit'), saved);
        inbox.accept('delete', {});
        inbox.complete('delete', [
            {
                ...base,
                event_id: '$delete',
                type: 'm.room.redaction',
                encrypted: false,
                redacts: '$original',
                content: {},
            },
        ]);
        assert.equal(await resumed.drain(), 1);
        assert.deepEqual(
            outbox.mutations
                .get(profile, '$delete')!
                .operation.commands.map((command) => command.action),
            ['delete', 'delete'],
        );
        assert.equal(
            outbox.mutations.claim(profile, '$delete', 0),
            false,
            'Earlier edit must settle before deletion',
        );
    } finally {
        inbox.close();
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
await test('unverified original content is rejected without acknowledging the edit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-original-')),
        key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key),
        outbox = new OutboxStore(join(directory, 'outbox'), key),
        portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    try {
        portals.bind(profile, chat, room);
        portals.bindOwnerEcho({
            profile,
            chat,
            room,
            sender: owner,
            message: 'm:0100000000000000',
            root: '$phone',
            latest: '$phone',
            digest: 'a'.repeat(64),
        });
        inbox.accept('edit', {});
        inbox.complete('edit', [
            {
                event_id: '$edit',
                sender: owner,
                room_id: room,
                type: 'm.room.message',
                encrypted: true,
                content: {
                    'm.relates_to': {rel_type: 'm.replace', event_id: '$phone'},
                    'm.new_content': {msgtype: 'm.text', body: 'new'},
                },
            },
        ]);
        let mode = 'missing';
        const ingress = new MutationIngress({
            profile,
            owner,
            inbox,
            outbox,
            portals,
            original: async () => {
                if (mode === 'missing') return undefined;
                if (mode === 'failure') throw new Error('Synthetic retrieval failure');
                return {
                    event_id: '$phone',
                    sender: '@other:invalid',
                    room_id: room,
                    type: 'm.room.message',
                    encrypted: true,
                    content: {msgtype: 'm.text', body: 'original'},
                };
            },
        });
        assert.equal(await ingress.drain(), 0);
        assert.equal(outbox.rejection(profile, '$edit'), undefined);
        mode = 'failure';
        await assert.rejects(ingress.drain());
        assert.equal(outbox.rejection(profile, '$edit'), undefined);
        mode = 'wrong-owner';
        assert.equal(await ingress.drain(), 0);
        assert(outbox.rejection(profile, '$edit'));
        assert.equal(outbox.mutations.get(profile, '$edit'), undefined);
        assert.equal(
            inbox.pendingDeliveryPage(10).length,
            1,
            'Notice worker must acknowledge after delivery',
        );
    } finally {
        inbox.close();
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

for (const kind of ['audio', 'file'] as const)
    await test(`audio caption admission follows durable ${kind} projection`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'mutation-audio-')),
            key = randomBytes(32);
        const inbox = new TransactionInbox(join(directory, 'inbox'), key),
            outbox = new OutboxStore(join(directory, 'outbox'), key),
            portals = new PortalStore(join(directory, 'portals'), key);
        const profile = 'SELF1234',
            owner = '@owner:invalid',
            room = '!room:invalid',
            chat = 'c:ABCD1234';
        const file = {
            url: 'mxc://invalid/audio',
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
        const content = {msgtype: 'm.audio', body: 'voice.flac', filename: 'voice.flac', file};
        try {
            portals.bind(profile, chat, room);
            outbox.media.prepare({
                id: createRequestId(),
                profile,
                owner,
                room,
                event: '$audio',
                transaction: 'audio',
                media: {
                    chat,
                    kind: 'm.audio',
                    filename: 'voice.flac',
                    mimeType: 'audio/flac',
                    bytes: 12,
                    file,
                },
            });
            assert(outbox.media.claim(profile, '$audio'));
            outbox.media.recordAudioProjection(
                profile,
                '$audio',
                kind === 'file'
                    ? {kind, fileName: 'voice.flac', mediaType: 'audio/flac', bytes: 12}
                    : {
                          kind,
                          fileName: 'voice.m4a',
                          mediaType: 'audio/mp4',
                          bytes: 100,
                          durationSeconds: 1,
                      },
            );
            outbox.media.recordIds(profile, '$audio', ['m:0100000000000000']);
            outbox.media.observe(profile, chat, 'm:0100000000000000');
            const base = {sender: owner, room_id: room, type: 'm.room.message', encrypted: true};
            inbox.accept('edit', {});
            inbox.complete('edit', [
                {
                    ...base,
                    event_id: '$edit',
                    content: {
                        'm.relates_to': {rel_type: 'm.replace', event_id: '$audio'},
                        'm.new_content': {...content, body: 'new caption'},
                    },
                },
            ]);
            const ingress = new MutationIngress({
                profile,
                owner,
                inbox,
                outbox,
                portals,
                original: async () => ({...base, event_id: '$audio', content}),
            });
            assert.equal(await ingress.drain(), kind === 'file' ? 1 : 0);
            if (kind === 'file') {
                assert.deepEqual(outbox.mutations.get(profile, '$edit')!.operation.commands, [
                    {
                        profile,
                        chatId: chat,
                        messageId: 'm:0100000000000000',
                        action: 'edit',
                        text: 'new caption',
                    },
                ]);
                assert.equal(outbox.rejection(profile, '$edit'), undefined);
            } else {
                assert.equal(outbox.mutations.get(profile, '$edit'), undefined);
                assert(outbox.rejection(profile, '$edit'));
            }
        } finally {
            inbox.close();
            outbox.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
