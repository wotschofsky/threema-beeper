import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {TransactionInbox, type InboxEvent} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {UnsupportedNoticeWorker} from '../src/outbox/unsupported-notices.ts';

await test('mutation admission owns pending changes while durable rejections retain notice delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mutation-notices-'));
    const key = randomBytes(32),
        profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid';
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const sent: string[] = [];
    const base = {room_id: room, sender: owner, encrypted: true};
    const edit: InboxEvent = {
        ...base,
        event_id: '$edit',
        type: 'm.room.message',
        content: {
            'msgtype': 'm.text',
            'body': '* edit',
            'm.relates_to': {rel_type: 'm.replace', event_id: '$original'},
            'm.new_content': {msgtype: 'm.text', body: 'edit'},
        },
    };
    const deletion: InboxEvent = {
        ...base,
        encrypted: false,
        event_id: '$delete',
        type: 'm.room.redaction',
        redacts: '$original',
        content: {},
    };
    const malformed: InboxEvent = {...deletion, event_id: '$malformed', redacts: '$malformed'};
    try {
        portals.bind(profile, 'c:TEST1234', room);
        inbox.accept('mutations', {});
        inbox.complete('mutations', [edit, deletion, malformed]);
        const options = {
            inbox,
            outbox,
            portals,
            profile,
            owner,
            ready: () => true,
            authorize: async () => {},
            send: async (_id: string, _room: string, content: Record<string, unknown>) => {
                sent.push(String(content.body));
            },
        };
        const worker = new UnsupportedNoticeWorker({...options, mutationsEnabled: true});
        assert.equal(await worker.drain(), 0);
        assert.equal(inbox.pendingEvents().length, 3);
        assert.equal(outbox.rejection(profile, edit.event_id), undefined);
        // Ingress owns the decision, including malformed changes; notices own delivery after rejection.
        outbox.rejectEvent(
            profile,
            malformed.event_id,
            room,
            'The message change target is invalid.',
        );
        assert.equal(await worker.drain(), 1);
        assert.equal(sent.length, 1);
        assert.match(sent[0]!, /target is invalid/);
        outbox.mutations.prepare({
            profile,
            owner,
            room,
            chat: 'c:TEST1234',
            event: edit.event_id,
            target: '$original',
            commands: [
                {
                    profile,
                    chatId: 'c:TEST1234',
                    messageId: 'm:0000000000000001',
                    action: 'edit',
                    text: 'edit',
                },
            ],
        });
        // A prepared plan survives a failed inbox ack and even a later disabled admission flag.
        const disabled = new UnsupportedNoticeWorker(options);
        assert.equal(await disabled.drain(), 1);
        assert.equal(outbox.rejection(profile, edit.event_id), undefined);
        assert(outbox.rejection(profile, deletion.event_id));
        assert.deepEqual(
            inbox.pendingEvents().map((event) => event.event_id),
            [edit.event_id],
        );
    } finally {
        outbox.close();
        inbox.close();
        portals.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('unsupported notices require encrypted owner events and authorization, retry durably and preserve supported messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unsupported-notices-'));
    const key = randomBytes(32),
        profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid';
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const events: InboxEvent[] = [
        {
            event_id: '$media',
            room_id: room,
            sender: owner,
            encrypted: true,
            type: 'm.room.message',
            content: {msgtype: 'm.image', body: 'PRIVATE FILE NAME'},
        },
        {
            event_id: '$text',
            room_id: room,
            sender: owner,
            encrypted: true,
            type: 'm.room.message',
            content: {msgtype: 'm.text', body: 'PRIVATE BODY'},
        },
        {
            event_id: '$plain',
            room_id: room,
            sender: owner,
            encrypted: false,
            type: 'm.room.message',
            content: {},
        },
        {
            event_id: '$foreign',
            room_id: room,
            sender: '@other:invalid',
            encrypted: true,
            type: 'm.reaction',
            content: {},
        },
    ];
    let authorized = false,
        ready = true;
    const ids: string[] = [];
    try {
        portals.bind(profile, 'c:TEST1234', room);
        inbox.accept('txn', {});
        inbox.complete('txn', events);
        const worker = new UnsupportedNoticeWorker({
            inbox,
            outbox,
            portals,
            profile,
            owner,
            ready: () => ready,
            authorize: async () => {
                if (!authorized) throw new Error('synthetic state failure');
            },
            send: async (id, target, content) => {
                ids.push(id);
                assert.equal(target, room);
                assert.equal(content.msgtype, 'm.notice');
                assert(!JSON.stringify(content).includes('PRIVATE'));
            },
        });
        await assert.rejects(worker.drain());
        assert.equal(ids.length, 0);
        assert.equal(inbox.pendingEvents().length, 4);
        authorized = true;
        const acknowledge = inbox.acknowledgeEvent.bind(inbox);
        inbox.acknowledgeEvent = () => {
            throw new Error('synthetic crash after notice');
        };
        await assert.rejects(worker.drain());
        inbox.acknowledgeEvent = acknowledge;
        assert.equal(await worker.drain(), 1);
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1], 'Retry must reuse persisted encrypted operation ID');
        assert.equal(inbox.pendingEvents().length, 3);
        ready = false;
        assert.equal(await worker.drain(), 0);
    } finally {
        outbox.close();
        inbox.close();
        portals.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
