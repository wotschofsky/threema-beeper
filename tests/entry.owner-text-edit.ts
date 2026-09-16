import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MessageDelivery} from '../src/matrix/message-delivery.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('phone text edits preserve owner roots, retry projections, and project reverts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-edit-')),
        key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    let portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:TEST1234';
    const id = createRequestId();
    const message: NormalizedNodeMessage = {
        direction: 'outbound',
        senderIdentity: profile,
        chatId: chat,
        messageId: 'm:0100000000000000',
        createdAt: new Date(1000),
        sentAt: new Date(1000),
        ordinal: 1n,
        reactions: [],
        content: {type: 'text', text: 'original'},
    };
    const sent: Record<string, unknown>[] = [];
    let fail = true;
    const sender = {
        send: async (
            operation: string,
            target: string,
            type: string,
            content: Record<string, unknown>,
        ) => {
            assert.equal(target, room);
            assert.equal(type, 'm.room.message');
            portals.prepareOperation({
                id: operation,
                sender: owner,
                room,
                digest: operation,
                ciphertext: '{}',
            });
            sent.push(content);
            if (fail) throw new Error('Lost response');
            const event = `$${operation}`;
            portals.completeOperation(operation, event);
            return event;
        },
    };
    try {
        portals.bind(profile, chat, room);
        outbox.prepare({
            requestId: id,
            profile,
            transactionId: 'txn',
            eventId: '$original',
            roomId: room,
            sender: owner,
            chatId: chat,
            text: 'original',
        });
        outbox.claim();
        outbox.recordIds(id, [message.messageId]);
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, message, true), true);
        outbox.mutations.prepare({
            profile,
            owner,
            room,
            chat,
            event: '$beeper-edit',
            target: '$original',
            commands: [
                {
                    profile,
                    chatId: chat,
                    messageId: message.messageId,
                    action: 'edit',
                    text: 'earlier Beeper edit',
                },
            ],
        });
        assert(outbox.mutations.claim(profile, '$beeper-edit', 0));
        outbox.mutations.finish(profile, '$beeper-edit', 0, 'APPLIED');
        assert.equal(
            reconcileOutboundEcho(
                outbox,
                portals,
                profile,
                owner,
                {...message, content: {type: 'text', text: 'earlier Beeper edit'}},
                true,
            ),
            true,
        );
        message.content = {type: 'text', text: 'phone edit'};
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, message, true), false);
        await assert.rejects(
            new MessageDelivery(portals).deliver(
                profile,
                room,
                owner,
                sender,
                message,
                'phone-edit',
            ),
            /Lost response/,
        );
        portals.close();
        portals = new PortalStore(join(directory, 'portals'), key);
        fail = false;
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, message, true), false);
        await new MessageDelivery(portals).deliver(
            profile,
            room,
            owner,
            sender,
            message,
            'phone-edit',
        );
        assert.deepEqual(sent[0], sent[1]);
        assert.deepEqual(sent[1]!['m.relates_to'], {rel_type: 'm.replace', event_id: '$original'});
        assert.equal(portals.messageMapping(profile, chat, message.messageId)!.sender, owner);
        const count = sent.length;
        await new MessageDelivery(portals).deliver(
            profile,
            room,
            owner,
            sender,
            message,
            'same-edit',
        );
        assert.equal(sent.length, count);
        message.content = {type: 'text', text: 'earlier Beeper edit'};
        assert.equal(
            reconcileOutboundEcho(outbox, portals, profile, owner, message, true),
            false,
            'Historical Beeper content must not hide a later phone change',
        );
        await new MessageDelivery(portals).deliver(
            profile,
            room,
            owner,
            sender,
            message,
            'phone-reuses-beeper-text',
        );
        assert.equal((sent.at(-1)!['m.new_content'] as {body: string}).body, 'earlier Beeper edit');
        message.content = {type: 'text', text: 'original'};
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, message, true), false);
        await new MessageDelivery(portals).deliver(
            profile,
            room,
            owner,
            sender,
            message,
            'phone-revert',
        );
        assert.deepEqual(sent.at(-1)!['m.relates_to'], {
            rel_type: 'm.replace',
            event_id: '$original',
        });
        assert.equal((sent.at(-1)!['m.new_content'] as {body: string}).body, 'original');
        message.replyToMessageId = 'm:0200000000000000';
        assert.throws(
            () => reconcileOutboundEcho(outbox, portals, profile, owner, message, true),
            /owner event handler/,
        );
    } finally {
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
