import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TransactionInbox, type InboxEvent} from '../src/matrix/transaction-inbox.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MatrixOutboxIngress} from '../src/outbox/matrix-ingress.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {sourceOrderPermits} from '../src/outbox/source-order.ts';

await test('arrival order survives reversed decryption and restart across text and reactions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-order-'));
    const key = randomBytes(32);
    let inbox = new TransactionInbox(join(directory, 'inbox'), key);
    let outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    const event = (id: string, type = 'm.room.message', roomId = room): InboxEvent => ({
        event_id: id,
        room_id: roomId,
        sender: owner,
        encrypted: true,
        type,
        content: {msgtype: 'm.text', body: id},
    });
    const allowed = (id: string) => sourceOrderPermits(inbox, outbox, profile, id, 'dispatch');
    try {
        portals.bind(profile, chat, room);
        inbox.accept('older', {});
        inbox.accept('later', {});
        inbox.complete('later', [event('$later')]);
        let ingress = new MatrixOutboxIngress({inbox, outbox, portals, profile, owner});
        assert.throws(() => ingress.drain());
        assert.equal(outbox.forEvent(profile, '$later'), undefined);
        assert.equal(allowed('$later'), false);
        inbox.complete('older', [event('$older'), event('$reaction', 'm.reaction')]);
        assert.throws(() => ingress.drain());
        const first = outbox.forEvent(profile, '$older')!;
        assert.ok(first);
        assert.equal(outbox.forEvent(profile, '$later'), undefined);
        assert.equal(allowed('$older'), true);
        outbox.claim(first.request.requestId);
        outbox.recordIds(first.request.requestId, ['m:0100000000000000']);
        assert.equal(allowed('$reaction'), false);
        outbox.sent(first.request.requestId, ['m:0100000000000000']);
        outbox.observe(profile, chat, 'm:0100000000000000');
        assert.equal(allowed('$reaction'), true);
        outbox.reactions.prepare({
            profile,
            owner,
            room,
            chat,
            event: '$reaction',
            target: '$older',
            emoji: '👍',
            action: 'apply',
            messages: ['m:0100000000000000'],
        });
        inbox.acknowledgeEvent('$reaction');
        ingress.drain();
        assert.ok(outbox.forEvent(profile, '$later'));
        assert.equal(allowed('$later'), false);
        const claimed = outbox.reactions.claim(profile)!;
        assert.equal(claimed.operation.event, '$reaction');
        inbox.close();
        outbox.close();
        inbox = new TransactionInbox(join(directory, 'inbox'), key);
        outbox = new OutboxStore(join(directory, 'outbox'), key);
        outbox.recoverInterrupted();
        assert.equal(allowed('$later'), false);
        inbox.accept('other', {});
        inbox.complete('other', [event('$other', 'm.room.message', '!other:invalid')]);
        assert.equal(allowed('$other'), true);
        assert.equal(allowed('$missing'), false);
        assert.equal(outbox.reactions.observeDesiredState(profile, '$reaction', 0, true), true);
        assert.equal(allowed('$later'), true);
    } finally {
        inbox.close();
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('legacy prepared text is reordered atomically without resetting retries or uncertain sends', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-repair-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    let outbox = new OutboxStore(join(directory, 'outbox'), key);
    const profile = 'SELF1234',
        room = '!room:invalid',
        sender = '@owner:invalid',
        chatId = 'c:ABCD1234';
    try {
        inbox.accept('source', {});
        inbox.complete(
            'source',
            ['$first', '$second', '$uncertain'].map((event_id) => ({
                event_id,
                room_id: room,
                sender,
                encrypted: true,
                type: 'm.room.message',
                content: {msgtype: 'm.text', body: event_id},
            })),
        );
        const prepare = (eventId: string) =>
            outbox.prepare({
                requestId: createRequestId(),
                profile,
                transactionId: 'source',
                eventId,
                roomId: room,
                sender,
                chatId,
                text: eventId,
            }).request.requestId;
        const second = prepare('$second');
        const first = prepare('$first');
        const uncertain = prepare('$uncertain');
        outbox.deferPreflight(first, 12345);
        const before = outbox.get(first);
        assert.equal(
            outbox.reorderPrepared((id) => inbox.sourcePosition(id)),
            2,
        );
        assert.deepEqual(outbox.get(first), before);
        assert.equal(
            outbox.nextPrepared(12344),
            undefined,
            'Backoff on the true first request still blocks later text',
        );
        assert.equal(outbox.claim(first, 12345)?.request.eventId, '$first');
        outbox.recordIds(first, ['m:0100000000000000']);
        outbox.sent(first, ['m:0100000000000000']);
        outbox.claim(second, 12345);
        outbox.recordIds(second, ['m:0200000000000000']);
        outbox.sent(second, ['m:0200000000000000']);
        outbox.claim(uncertain, 12345);
        outbox.unknown(uncertain);
        const unknownBefore = outbox.get(uncertain);
        outbox.close();
        outbox = new OutboxStore(join(directory, 'outbox'), key);
        assert.equal(
            outbox.reorderPrepared((id) => inbox.sourcePosition(id)),
            0,
        );
        assert.deepEqual(outbox.get(uncertain), unknownBefore);
        const missing = prepare('$missing');
        const missingBefore = outbox.get(missing);
        assert.equal(
            outbox.reorderPrepared((id) => inbox.sourcePosition(id)),
            0,
        );
        assert.deepEqual(outbox.get(missing), missingBefore);
        assert.equal(outbox.claim(), undefined, 'Uncertain predecessor is never made sendable');
    } finally {
        inbox.close();
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('mutation predecessors block cross-kind dispatch until applied or rejected', () => {
    for (const state of ['APPLIED', 'REJECTED', 'OUTCOME_UNKNOWN'] as const) {
        const directory = mkdtempSync(join(tmpdir(), 'mutation-source-order-')),
            key = randomBytes(32);
        const inbox = new TransactionInbox(join(directory, 'inbox'), key),
            outbox = new OutboxStore(join(directory, 'outbox'), key);
        const profile = 'SELF1234',
            room = '!room:invalid',
            chat = 'c:ABCD1234',
            owner = '@owner:invalid';
        try {
            inbox.accept('batch', {});
            inbox.complete('batch', [
                {
                    event_id: '$delete',
                    type: 'm.room.redaction',
                    sender: owner,
                    room_id: room,
                    content: {},
                    redacts: '$original',
                },
                {
                    event_id: '$later',
                    type: 'm.room.message',
                    sender: owner,
                    room_id: room,
                    encrypted: true,
                    content: {msgtype: 'm.text', body: 'later'},
                },
            ]);
            assert.equal(sourceOrderPermits(inbox, outbox, profile, '$later', 'ingress'), false);
            outbox.mutations.prepare({
                profile,
                room,
                chat,
                owner,
                event: '$delete',
                target: '$original',
                commands: [
                    {profile, chatId: chat, messageId: 'm:0100000000000000', action: 'delete'},
                    {profile, chatId: chat, messageId: 'm:0200000000000000', action: 'delete'},
                ],
            });
            inbox.acknowledgeEvent('$delete');
            assert.equal(sourceOrderPermits(inbox, outbox, profile, '$later', 'ingress'), true);
            assert.equal(sourceOrderPermits(inbox, outbox, profile, '$later', 'dispatch'), false);
            assert(outbox.mutations.claim(profile, '$delete', 0));
            outbox.mutations.finish(
                profile,
                '$delete',
                0,
                state,
                state === 'REJECTED' ? 'delete-window-expired' : undefined,
            );
            if (state === 'APPLIED') {
                assert.equal(
                    sourceOrderPermits(inbox, outbox, profile, '$later', 'dispatch'),
                    false,
                    'Every part must settle',
                );
                assert(outbox.mutations.claim(profile, '$delete', 1));
                outbox.mutations.finish(profile, '$delete', 1, 'APPLIED');
            }
            assert.equal(
                sourceOrderPermits(inbox, outbox, profile, '$later', 'dispatch'),
                state !== 'OUTCOME_UNKNOWN',
            );
        } finally {
            inbox.close();
            outbox.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    }
});

await test('undecryptable ciphertext in one room does not freeze another room', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-room-isolation-'));
    const key = randomBytes(32);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const owner = '@owner:invalid';
    try {
        inbox.accept('stuck', {
            events: [
                {
                    event_id: '$stuck',
                    room_id: '!old:invalid',
                    sender: owner,
                    type: 'm.room.encrypted',
                    content: {},
                },
            ],
        });
        inbox.accept('keys', {events: [], device_lists: {changed: [owner]}});
        inbox.accept('current', {events: []});
        inbox.complete('current', [
            {
                event_id: '$new',
                room_id: '!new:invalid',
                sender: owner,
                type: 'm.room.message',
                encrypted: true,
                content: {msgtype: 'm.text', body: 'fixture'},
            },
        ]);
        assert.equal(
            inbox.predecessorsPermit('$new', () => true),
            true,
        );
        inbox.accept('same', {events: []});
        inbox.complete('same', [
            {
                event_id: '$same',
                room_id: '!old:invalid',
                sender: owner,
                type: 'm.room.message',
                encrypted: true,
                content: {msgtype: 'm.text', body: 'fixture'},
            },
        ]);
        assert.equal(
            inbox.predecessorsPermit('$same', () => true),
            false,
            'same-room ciphertext must preserve source order',
        );
    } finally {
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
