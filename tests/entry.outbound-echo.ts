import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('owner echo mapping survives interruption before acknowledgement and rejects conflicting identity or content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-echo-'));
    const key = randomBytes(32),
        owner = '@owner:invalid',
        profile = 'SELF1234';
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    let portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const id = createRequestId(),
        room = '!room:invalid',
        chat = 'c:TEST1234';
    const message: NormalizedNodeMessage = {
        direction: 'outbound',
        senderIdentity: profile,
        chatId: chat,
        messageId: 'm:ffffffffffffffff',
        createdAt: new Date(1000),
        sentAt: new Date(1000),
        ordinal: 1n,
        reactions: [],
        content: {type: 'text', text: 'original'},
    };
    try {
        portals.bind(profile, chat, room);
        outbox.prepare({
            requestId: id,
            profile,
            transactionId: 'txn',
            eventId: '$owner',
            roomId: room,
            sender: owner,
            chatId: chat,
            text: 'original',
        });
        outbox.claim();
        outbox.recordIds(id, [message.messageId]);
        const observe = outbox.observe.bind(outbox);
        outbox.observe = () => {
            throw new Error('synthetic acknowledgement interruption');
        };
        assert.throws(
            () => reconcileOutboundEcho(outbox, portals, profile, owner, message),
            /interruption/,
        );
        assert.equal(outbox.get(id)!.state, 'DISPATCHING');
        portals.close();
        portals = new PortalStore(join(directory, 'portals.sqlite'), key);
        outbox.observe = observe;
        outbox.recoverInterrupted();
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, message), true);
        assert.equal(outbox.get(id)!.state, 'ACKED');
        assert.equal(portals.messageMapping(profile, chat, message.messageId)!.root, '$owner');
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, message), true);
        assert.throws(
            () =>
                reconcileOutboundEcho(outbox, portals, profile, owner, {
                    ...message,
                    direction: 'inbound',
                }),
            /identity conflict/,
        );
        assert.throws(
            () =>
                reconcileOutboundEcho(outbox, portals, profile, owner, {
                    ...message,
                    content: {type: 'text', text: 'edited elsewhere'},
                }),
            /mutation/,
        );
        assert.equal(
            reconcileOutboundEcho(outbox, portals, profile, owner, {
                ...message,
                messageId: 'm:0100000000000000',
            }),
            false,
        );
        const edit = {
            profile,
            owner,
            room,
            chat,
            event: '$edit',
            target: '$owner',
            commands: [
                {
                    profile,
                    chatId: chat,
                    messageId: message.messageId,
                    action: 'edit' as const,
                    text: 'accepted edit',
                },
            ],
        };
        const edited: NormalizedNodeMessage = {
            ...message,
            content: {type: 'text', text: 'accepted edit'},
        };
        outbox.mutations.prepare(edit);
        assert.throws(
            () => reconcileOutboundEcho(outbox, portals, profile, owner, edited),
            /mutation/,
        );
        assert(outbox.mutations.claim(profile, edit.event, 0));
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, edited), true);
        assert.equal(
            outbox.mutations.get(profile, edit.event)!.states[0],
            'DISPATCHING',
            'Echo does not commit an active mutation attempt',
        );
        outbox.recoverInterrupted();
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, edited), true);
        assert.equal(outbox.mutations.get(profile, edit.event)!.states[0], 'OUTCOME_UNKNOWN');
        assert(outbox.mutations.observeDesiredState(profile, edit.event, 0, true));
        assert.equal(reconcileOutboundEcho(outbox, portals, profile, owner, edited), true);
        assert.equal(portals.messageMapping(profile, chat, message.messageId)!.root, '$owner');
        assert.throws(
            () =>
                reconcileOutboundEcho(outbox, portals, profile, owner, {
                    ...edited,
                    replyToMessageId: 'm:0000000000000001',
                }),
            /mutation/,
        );
        const later = {
            ...edit,
            event: '$later-edit',
            commands: [{...edit.commands[0]!, text: 'newer edit'}],
        };
        outbox.mutations.prepare(later);
        assert(outbox.mutations.claim(profile, later.event, 0));
        outbox.mutations.finish(profile, later.event, 0, 'APPLIED');
        assert.throws(
            () => reconcileOutboundEcho(outbox, portals, profile, owner, edited),
            /mutation/,
        );
        assert.equal(
            reconcileOutboundEcho(outbox, portals, profile, owner, {
                ...edited,
                content: {type: 'text', text: 'newer edit'},
            }),
            true,
        );
    } finally {
        outbox.close();
        portals.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
