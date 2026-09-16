import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {ReactionDelivery} from '../src/matrix/reaction-delivery.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
await test('owner reaction echoes reuse visible Matrix references and remove obsolete ghost duplicates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-echo-'));
    const key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const profile = 'SELF1234',
        chat = 'c:ABCD1234',
        room = '!chat:invalid',
        messageId = 'm:0100000000000000';
    try {
        portals.bind(profile, chat, room);
        portals.bindOwnerEcho({
            profile,
            chat,
            room,
            message: messageId,
            sender: '@owner:invalid',
            root: '$text',
            latest: '$text',
            digest: 'a'.repeat(64),
        });
        const message: NormalizedNodeMessage = {
            messageId,
            chatId: chat,
            direction: 'outbound',
            senderIdentity: profile,
            createdAt: new Date(1000),
            sentAt: new Date(1001),
            ordinal: 1n,
            content: {type: 'text', text: 'Hello'},
            reactions: [{senderIdentity: profile, emoji: '👍', reactedAt: new Date(2000)}],
        };
        let present = false,
            outage = false;
        const delivery = new ReactionDelivery(portals, outbox.reactions, async () => {
            if (outage) throw new Error('backend unavailable');
            return present;
        });
        let sends = 0;
        const removed: string[] = [];
        const senderFor = async () => ({send: async () => `$ghost${++sends}`});
        const redactor = {
            redact: async (_id: string, _room: string, event: string) => {
                removed.push(event);
                return '$redacted';
            },
        };
        await delivery.reconcile(profile, message, 'stale-present', senderFor, redactor);
        assert.equal(sends, 0, 'An old snapshot must not recreate a removed owner reaction');
        present = true;
        await delivery.reconcile(profile, message, 'initial', senderFor, redactor);
        assert.equal(sends, 1);
        await delivery.reconcile(
            profile,
            {...message, reactions: []},
            'stale-absent',
            senderFor,
            redactor,
        );
        assert.deepEqual(removed, [], 'An old snapshot must not remove a current owner reaction');
        outage = true;
        await assert.rejects(delivery.reconcile(profile, message, 'outage', senderFor, redactor));
        assert.equal(sends, 1);
        assert.deepEqual(removed, []);
        outage = false;
        outbox.reactions.prepare({
            profile,
            chat,
            room,
            owner: '@owner:invalid',
            event: '$ownerreaction',
            target: '$text',
            action: 'apply',
            emoji: '👍',
            messages: [messageId],
        });
        await delivery.reconcile(profile, message, 'echo', senderFor, redactor);
        assert.equal(sends, 1);
        assert.deepEqual(removed, ['$ghost1']);
        assert.equal(portals.reactions(profile, chat, messageId).length, 0);
        await delivery.reconcile(profile, message, 'repeat', senderFor, redactor);
        assert.equal(sends, 1);
        outbox.reactions.prepare({
            profile,
            chat,
            room,
            owner: '@owner:invalid',
            event: '$withdraw',
            target: '$ownerreaction',
            action: 'withdraw',
            emoji: '👍',
            messages: [messageId],
        });
        assert.equal(outbox.reactions.activeReferences(profile, chat, messageId).size, 0);
        present = false;
        await delivery.reconcile(profile, message, 'stale-after-withdrawal', senderFor, redactor);
        assert.equal(sends, 1);
    } finally {
        portals.close();
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
