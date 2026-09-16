import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MessageDelivery} from '../src/matrix/message-delivery.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('message projection recovers send-before-mapping crash and converges edits without duplicate originals', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-projection-'));
    const filename = join(directory, 'portals.sqlite');
    const key = randomBytes(32);
    let store = new PortalStore(filename, key);
    let delivery = new MessageDelivery(store);
    const profile = 'SELF1234',
        room = '!portal:matrix.invalid',
        mxid = '@ghost:matrix.invalid';
    const message: NormalizedNodeMessage = {
        messageId: 'm:0100000000000000',
        chatId: 'c:TEST1234',
        direction: 'inbound',
        senderIdentity: 'TEST1234',
        createdAt: new Date(1234),
        ordinal: 1n,
        reactions: [],
        content: {type: 'text', text: 'Original'},
    };
    const events: Record<string, unknown>[] = [];
    let failAfterSend = true;
    const sender = {
        send: async (
            id: string,
            target: string,
            type: string,
            content: Record<string, unknown>,
        ) => {
            assert.equal(target, room);
            assert.equal(type, 'm.room.message');
            const old = store.operation(id);
            if (old?.event) return old.event;
            const event = `$event${events.length}`;
            events.push(content);
            // Model the EncryptedSender's durable completion boundary; its crypto path has separate native tests.
            store.prepareOperation({
                id,
                sender: mxid,
                room,
                digest: 'synthetic',
                ciphertext: 'synthetic',
            });
            store.completeOperation(id, event);
            if (failAfterSend) {
                failAfterSend = false;
                throw new Error('synthetic crash before mapping');
            }
            return event;
        },
    };
    const send = (value: NormalizedNodeMessage, id: string) =>
        delivery.deliver(profile, room, mxid, sender, value, id);
    try {
        store.bind(profile, message.chatId, room);
        await assert.rejects(send(message, 'first'), /crash/);
        assert.ok(store.projection('first'));
        await assert.rejects(
            send({...message, content: {type: 'text', text: 'Later'}}, 'later'),
            /unfinished projection/,
        );
        assert.equal(store.messageMapping(profile, message.chatId, message.messageId), undefined);
        store.close();
        store = new PortalStore(filename, key);
        delivery = new MessageDelivery(store);
        assert.equal(await send(message, 'first'), '$event0');
        assert.equal(events.length, 1);
        assert.equal(store.projection('first'), undefined);
        const receipt = {...message, readAt: new Date(3000)};
        assert.equal(await send(receipt, 'receipt'), '$event0');
        assert.equal(events.length, 1);
        const edited = {
            ...message,
            editedAt: new Date(4000),
            content: {type: 'text' as const, text: 'Edited'},
        };
        assert.equal(await send(edited, 'edit-1'), '$event1');
        assert.deepEqual(events[1]!['m.relates_to'], {rel_type: 'm.replace', event_id: '$event0'});
        assert.equal((events[1]!['m.new_content'] as {body: string}).body, 'Edited');
        assert.equal(await send(message, 'edit-2'), '$event2');
        assert.equal(
            store.messageMapping(profile, message.chatId, message.messageId)?.root,
            '$event0',
        );
        const reply = {
            ...message,
            messageId: 'm:0200000000000000',
            ordinal: 2n,
            replyToMessageId: message.messageId,
        };
        await send(reply, 'reply');
        assert.deepEqual(events[3]!['m.relates_to'], {'m.in_reply_to': {event_id: '$event0'}});
        assert.deepEqual(events[3]!['com.threema.bridge'], {
            message_id: reply.messageId,
            created_at: 1234,
        });
        await assert.rejects(
            send({...message, content: {type: 'deleted'}}, 'delete'),
            /another projector/,
        );
        await assert.rejects(
            delivery.deliver(
                profile,
                room,
                '@changed:matrix.invalid',
                sender,
                message,
                'identity-change',
            ),
            /identity changed/,
        );
        assert.equal(events.length, 4);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('reply to retained history in a replaced room uses the unavailable-target fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-reply-replacement-'));
    const key = randomBytes(32);
    const store = new PortalStore(join(directory, 'portals.sqlite'), key);
    const profile = 'SELF1234',
        chat = 'c:TEST1234',
        senderId = '@ghost:matrix.invalid';
    try {
        store.bind(profile, chat, '!old:matrix.invalid');
        store.bindOwnerEcho({
            profile,
            chat,
            message: 'm:0100000000000000',
            room: '!old:matrix.invalid',
            sender: senderId,
            root: '$history',
            latest: '$history',
            digest: 'old',
        });
        store.replaceRoom(profile, chat, '!old:matrix.invalid', '!new:matrix.invalid');
        const sender = {
            send: async (
                id: string,
                room: string,
                _type: string,
                content: Record<string, unknown>,
            ) => {
                assert.equal(
                    content['m.relates_to'],
                    undefined,
                    'Never reference an event from another room',
                );
                assert.equal(content['com.threema.reply_to'], 'm:0100000000000000');
                store.prepareOperation({id, room, sender: senderId, digest: 'd', ciphertext: '{}'});
                store.completeOperation(id, '$reply');
                return '$reply';
            },
        };
        await new MessageDelivery(store).deliver(
            profile,
            '!new:matrix.invalid',
            senderId,
            sender,
            {
                messageId: 'm:0200000000000000',
                chatId: chat,
                direction: 'inbound',
                senderIdentity: 'TEST1234',
                createdAt: new Date(1),
                ordinal: 2n,
                reactions: [],
                content: {type: 'text', text: 'Reply'},
                replyToMessageId: 'm:0100000000000000',
            },
            'reply',
        );
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
