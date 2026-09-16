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
import {createReactionRuntime} from '../src/outbox/reaction-runtime.ts';
import {UnsupportedNoticeWorker} from '../src/outbox/unsupported-notices.ts';
await test('runtime applies and withdraws reactions without racing unsupported notices', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-runtime-'));
    const key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    const bot = {
        userId: '@bot:invalid',
        underlyingClient: {
            getRoomState: async (): Promise<any[]> => [
                {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {algorithm: 'm.megolm.v1.aes-sha2'},
                },
                {
                    type: 'm.bridge',
                    state_key: 'threema://bridge',
                    sender: '@bot:invalid',
                    content: {creator: owner, network: {id: profile}, channel: {id: chat}},
                },
                {type: 'm.room.member', state_key: owner, content: {membership: 'join'}},
            ],
        },
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
            eventId: '$text',
            transactionId: 'text',
            text: 'Hello',
        });
        outbox.claim(id);
        outbox.recordIds(id, ['m:0100000000000000']);
        outbox.sent(id, ['m:0100000000000000']);
        const options = {profile, owner, portals, outbox, inbox, bot, ready: () => true};
        const calls: string[] = [];
        const redacted: string[] = [];
        let present = false;
        const runtime = createReactionRuntime({
            ...options,
            backend: {
                reactMessage: async (request) => {
                    calls.push(request.action);
                    present = request.action === 'apply';
                },
                reactionState: async () => present,
            },
            send: async () => {
                assert.fail('No reaction failed');
            },
            redact: async (_id, _room, event) => {
                redacted.push(event);
            },
        });
        const notices = new UnsupportedNoticeWorker({
            ...options,
            reactionsEnabled: true,
            authorize: async () => {},
            send: async () => {
                assert.fail('Supported reaction was rejected');
            },
        });
        inbox.accept('blocker', {});
        inbox.complete('blocker', [
            {
                event_id: '$blocker',
                room_id: room,
                sender: owner,
                encrypted: true,
                type: 'm.room.message',
                content: {msgtype: 'm.text', body: 'Earlier text'},
            },
        ]);
        const blocker = createRequestId();
        outbox.prepare({
            requestId: blocker,
            profile,
            sender: owner,
            roomId: room,
            chatId: chat,
            eventId: '$blocker',
            transactionId: 'blocker',
            text: 'Earlier text',
        });
        outbox.claim(blocker);
        outbox.recordIds(blocker, ['m:0200000000000000']);
        inbox.accept('apply', {});
        inbox.complete('apply', [
            {
                event_id: '$apply',
                room_id: room,
                sender: owner,
                type: 'm.reaction',
                content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$text', key: '👍'}},
            },
        ]);
        assert.equal(await notices.drain(), 0);
        await assert.rejects(runtime.drain(), /requires retry/);
        assert.deepEqual(calls, [], 'Reaction runtime must wait for earlier text dispatch');
        assert.deepEqual(outbox.reactions.get(profile, '$apply')!.states, ['PREPARED']);
        outbox.sent(blocker, ['m:0200000000000000']);
        inbox.acknowledgeEvent('$blocker');
        await runtime.drain();
        assert.deepEqual(calls, ['apply']);
        inbox.accept('withdraw', {});
        inbox.complete('withdraw', [
            {
                event_id: '$withdraw',
                room_id: room,
                sender: owner,
                type: 'm.room.redaction',
                redacts: '$apply',
                content: {},
            },
        ]);
        assert.equal(await notices.drain(), 0);
        await runtime.drain();
        assert.deepEqual(calls, ['apply', 'withdraw']);
        assert.equal(inbox.pendingEvents().length, 0);
        assert.equal(outbox.rejection(profile, '$apply'), undefined);
        assert.equal(outbox.rejection(profile, '$withdraw'), undefined);
        inbox.accept('apply-again', {});
        inbox.complete('apply-again', [
            {
                event_id: '$apply-again',
                room_id: room,
                sender: owner,
                encrypted: true,
                type: 'm.reaction',
                content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$text', key: '👍'}},
            },
        ]);
        await runtime.drain();
        assert.deepEqual(redacted, []);
        present = false; // A later phone-originated removal, observed through backend state.
        await runtime.drain();
        assert.deepEqual(redacted, ['$apply-again']);
        assert.equal(outbox.reactions.retirement(profile, '$apply-again')?.done, true);
    } finally {
        inbox.close();
        portals.close();
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
