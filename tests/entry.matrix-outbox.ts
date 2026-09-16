import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {TransactionInbox, type InboxEvent} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {MatrixOutboxIngress} from '../src/outbox/matrix-ingress.ts';
import {splitReplyText, unavailableReplyText} from '../src/outbox/reply-text.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {ManagementWorker} from '../src/management/worker.ts';

await test('decrypted owner text queues durably and replay across inbox acknowledgement cannot duplicate sends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-matrix-outbox-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const filename = join(directory, 'outbox.sqlite');
    let outbox = new OutboxStore(filename, key);
    const owner = '@owner:invalid',
        profile = 'SELF1234',
        room = '!room:invalid';
    const event: InboxEvent = {
        event_id: '$event',
        room_id: room,
        sender: owner,
        type: 'm.room.message',
        encrypted: true,
        content: {msgtype: 'm.text', body: 'encrypted owner fixture'},
    };
    const insert = (value: InboxEvent, txn: string) => {
        inbox.accept(txn, {});
        inbox.complete(txn, [value]);
    };
    try {
        portals.bind(profile, 'c:TEST1234', room);
        insert(event, 'txn1');
        // Model a crash after outbox commit but before inbox acknowledgement.
        const saved = outbox.prepare({
            requestId: createRequestId(),
            profile,
            transactionId: 'txn1',
            eventId: event.event_id,
            roomId: room,
            sender: owner,
            chatId: 'c:TEST1234',
            text: String(event.content.body),
        });
        outbox.close();
        outbox = new OutboxStore(filename, key);
        let ingress = new MatrixOutboxIngress({inbox, outbox, portals, owner, profile});
        assert.equal(ingress.drain(), 1);
        assert.equal(inbox.pendingEvents().length, 0);
        const claimed = outbox.claim()!;
        assert.equal(claimed.request.requestId, saved.request.requestId);
        assert.equal(claimed.request.transactionId, 'txn1');
        outbox.recordIds(claimed.request.requestId, ['m:0100000000000000']);
        outbox.sent(claimed.request.requestId, ['m:0100000000000000']);
        assert.equal(outbox.claim(), undefined);
        insert(event, 'txn2');
        assert.equal(ingress.drain(), 0);
        assert.equal(outbox.claim(), undefined);
        portals.bindOwnerEcho({
            profile,
            chat: 'c:TEST1234',
            message: 'm:0100000000000000',
            room,
            sender: owner,
            root: '$event',
            latest: '$event',
            digest: 'fixture',
        });
        insert(
            {
                ...event,
                event_id: '$mapped-reply',
                content: {
                    'msgtype': 'm.text',
                    'body': '> <@owner:invalid> quoted text\n> second line\n\nActual reply',
                    'm.relates_to': {'m.in_reply_to': {event_id: '$event'}},
                },
            },
            'txn-mapped',
        );
        assert.equal(ingress.drain(), 1);
        const mapped = outbox.claim()!;
        assert.equal(mapped.request.text, 'Actual reply');
        assert.equal(mapped.request.replyTo, 'm:0100000000000000');
        outbox.recordIds(mapped.request.requestId, ['m:0300000000000000']);
        outbox.sent(mapped.request.requestId, ['m:0300000000000000']);
        // Foreign senders and rooms do not enter the outbox.
        insert({...event, event_id: '$foreign', sender: '@ghost:invalid'}, 'txn3');
        insert({...event, event_id: '$wrong-room', room_id: '!other:invalid'}, 'txn4');
        assert.equal(ingress.drain(), 1);
        assert.equal(outbox.claim(), undefined);
        // An owner plaintext event cannot forge encryption using content fields.
        insert(
            {
                ...event,
                event_id: '$plain',
                encrypted: false,
                content: {...event.content, encrypted: true},
            },
            'txn5',
        );
        insert(
            {
                ...event,
                event_id: '$edit',
                content: {
                    ...event.content,
                    'm.relates_to': {rel_type: 'm.replace', event_id: '$event'},
                },
            },
            'txn6',
        );
        insert(
            {
                ...event,
                event_id: '$reply',
                content: {
                    ...event.content,
                    'm.relates_to': {'m.in_reply_to': {event_id: '$missing'}},
                },
            },
            'txn7',
        );
        insert({...event, event_id: '$valid'}, 'txn8');
        ingress = new MatrixOutboxIngress({inbox, outbox, portals, owner, profile});
        await assert.rejects(async () => ingress.drain(), /remain pending/);
        assert.equal(
            outbox.forEvent(profile, '$reply'),
            undefined,
            'Later text waits for the unsupported edit to be classified',
        );
        outbox.rejectEvent(profile, '$edit', room, 'Sending edits is not implemented yet.');
        await assert.rejects(async () => ingress.drain(), /remain pending/);
        assert.deepEqual(
            inbox.pendingEvents().map((value) => value.event_id),
            ['$wrong-room', '$plain', '$edit'],
        );
        const fallback = outbox.claim()!;
        assert.equal(fallback.request.eventId, '$reply');
        assert.equal(fallback.request.replyTo, undefined);
        assert.equal(
            fallback.request.text,
            '[Reply fallback: original unavailable]\n\nencrypted owner fixture',
        );
        outbox.recordIds(fallback.request.requestId, ['m:0200000000000000']);
        outbox.sent(fallback.request.requestId, ['m:0200000000000000']);
        assert.equal(outbox.claim()!.request.eventId, '$valid');
        assert.equal(outbox.claim(), undefined);
        insert(
            {
                ...event,
                event_id: '$membership',
                state_key: owner,
                type: 'm.room.member',
                content: {membership: 'join'},
            },
            'txn9',
        );
        assert.equal(ingress.drain(), 0, 'New state event is preserved while the scan advances');
        await assert.rejects(async () => ingress.drain(), /remain pending/);
        assert.ok(inbox.pendingEvents().some((value) => value.event_id === '$membership'));
    } finally {
        inbox.close();
        portals.close();
        outbox.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('legacy inbox events remain pending without inventing transaction or encryption provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-inbox-migration-'));
    const key = randomBytes(32),
        filename = join(directory, 'inbox.sqlite');
    const {default: Database} = await import(
        '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js'
    );
    const legacy = new Database(filename);
    legacy.pragma('cipher_compatibility = 4');
    legacy.pragma(`key = "x'${key.toString('hex')}'"`);
    legacy.exec(
        "CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending'); PRAGMA user_version=1;",
    );
    legacy
        .prepare('INSERT INTO events(event_id,body) VALUES(?,?)')
        .run('$legacy', JSON.stringify({event_id: '$legacy', content: {}}));
    legacy.close();
    const inbox = new TransactionInbox(filename, key);
    try {
        assert.equal(inbox.pendingDeliveries()[0]!.transactionId, null);
        assert.equal(inbox.pendingDeliveries()[0]!.event.encrypted, undefined);
        assert.equal(inbox.pendingEvents()[0]!.event_id, '$legacy');
    } finally {
        inbox.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('reply text strips only the leading fallback and bounds unverified excerpts', () => {
    assert.deepEqual(splitReplyText('> <@someone:invalid> old\n> second\n\n  reply\n> keep'), {
        body: '  reply\n> keep',
        quote: '<@someone:invalid> old\nsecond',
    });
    assert.deepEqual(splitReplyText('reply without fallback'), {
        body: 'reply without fallback',
        quote: '',
    });
    assert.deepEqual(splitReplyText('> quote only'), {body: '', quote: 'quote only'});
    assert.deepEqual(splitReplyText('>x\nbody'), {body: '>x\nbody', quote: ''});
    assert.deepEqual(splitReplyText('> quote\n\n\nreply'), {body: '\nreply', quote: 'quote'});
    const fallback = unavailableReplyText('reply', '😀'.repeat(321));
    assert.ok(fallback.includes('😀'.repeat(320) + '…'));
    assert.ok(fallback.endsWith('\n\nreply'));
    assert.ok(fallback.includes('client-provided quote'));
});

await test('text outbox and management consumer preserve each other’s events in the shared inbox', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shared-inbox-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!management:invalid';
    try {
        portals.bind(profile, 'c:ABCD1234', '!chat:invalid');
        const events: InboxEvent[] = [
            {event_id: '$management', room_id: room, content: {msgtype: 'm.text', body: 'status'}},
            {
                event_id: '$chat',
                room_id: '!chat:invalid',
                content: {msgtype: 'm.text', body: 'Hello'},
            },
        ].map((event) => ({...event, sender: owner, type: 'm.room.message', encrypted: true}));
        inbox.accept('both', {});
        inbox.complete('both', events);
        const ingress = new MatrixOutboxIngress({inbox, outbox, portals, owner, profile});
        assert.equal(ingress.drain(), 1);
        assert.deepEqual(
            inbox.pendingEvents().map((event) => event.event_id),
            ['$management'],
        );
        assert.equal(outbox.claim()!.request.eventId, '$chat');
        let executed = 0,
            sent = 0;
        const management = new ManagementWorker({
            inbox,
            owner,
            room,
            ready: () => true,
            authorize: async () => {},
            execute: async (command) => {
                assert.equal(command.kind, 'status');
                executed++;
                return {msgtype: 'm.notice', body: 'Ready'};
            },
            send: async () => {
                sent++;
            },
        });
        assert.equal(await management.drain(), 1);
        assert.equal(executed, 1);
        assert.equal(sent, 1);
        assert.equal(inbox.pendingEvents().length, 0);
        assert.equal(ingress.drain(), 0);
        assert.equal(await management.drain(), 0);
    } finally {
        inbox.close();
        portals.close();
        outbox.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('native text byte limits reject durably after reply projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'text-byte-limit-')),
        key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key),
        portals = new PortalStore(join(directory, 'portals'), key),
        outbox = new OutboxStore(join(directory, 'outbox'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    const base = {sender: owner, room_id: room, type: 'm.room.message', encrypted: true};
    try {
        portals.bind(profile, chat, room);
        portals.bindOwnerEcho({
            profile,
            chat,
            room,
            sender: owner,
            message: 'm:0100000000000000',
            root: '$known',
            latest: '$known',
            digest: 'a'.repeat(64),
        });
        const cases = [
            {id: '$oversize', body: '🙂'.repeat(1501), rejected: true},
            {id: '$boundary', body: '🙂'.repeat(1500), rejected: false},
            {
                id: '$known-reply',
                body: '> ' + 'q'.repeat(7000) + '\n\nshort reply',
                target: '$known',
                rejected: false,
            },
            {id: '$fallback', body: 'x'.repeat(6000), target: '$missing', rejected: true},
        ];
        for (const fixture of cases) {
            inbox.accept(fixture.id, {});
            inbox.complete(fixture.id, [
                {
                    ...base,
                    event_id: fixture.id,
                    content: {
                        msgtype: 'm.text',
                        body: fixture.body,
                        ...(fixture.target
                            ? {'m.relates_to': {'m.in_reply_to': {event_id: fixture.target}}}
                            : {}),
                    },
                },
            ]);
            const ingress = new MatrixOutboxIngress({inbox, portals, outbox, profile, owner});
            if (fixture.rejected) {
                assert.throws(() => ingress.drain());
                assert.equal(outbox.forEvent(profile, fixture.id), undefined);
                assert.match(outbox.rejection(profile, fixture.id)!.reason, /6000 UTF-8 bytes/);
                assert(inbox.pendingEvents().some((event) => event.event_id === fixture.id));
                // Simulate the notice consumer acknowledging a successfully delivered rejection.
                inbox.acknowledgeEvent(fixture.id);
            } else {
                assert.equal(ingress.drain(), 1);
                const request = outbox.forEvent(profile, fixture.id)!.request;
                assert(Buffer.byteLength(request.text) <= 6000);
                if (fixture.target) assert.equal(request.text, 'short reply');
            }
        }
    } finally {
        inbox.close();
        portals.close();
        outbox.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
