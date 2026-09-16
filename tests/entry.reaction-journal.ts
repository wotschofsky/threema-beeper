import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {ReactionOperation} from '../src/outbox/reaction-journal.ts';

await test('reaction journal persists multipart progress, isolates uncertain chats and prevents reclassification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-journal-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(filename, key);
    const operation: ReactionOperation = {
        profile: 'SELF1234',
        event: '$reaction',
        room: '!chat:invalid',
        owner: '@owner:invalid',
        chat: 'c:ABCD1234',
        target: '$target',
        emoji: '👍',
        action: 'apply',
        messages: ['m:0100000000000000', 'm:0200000000000000'],
    };
    try {
        store.reactions.prepare(operation);
        store.reactions.prepare({...operation});
        assert.throws(() => store.reactions.prepare({...operation, emoji: '👎'}));
        assert.throws(() =>
            store.rejectEvent(operation.profile, operation.event, operation.room, 'unsupported'),
        );
        assert.throws(() =>
            store.prepare({
                requestId: createRequestId(),
                profile: operation.profile,
                transactionId: 'transaction',
                eventId: operation.event,
                roomId: operation.room,
                sender: operation.owner,
                chatId: operation.chat,
                text: 'wrong classification',
            }),
        );
        assert.equal(store.reactions.claim('OTHER123'), undefined);
        assert.deepEqual(store.reactions.claim(operation.profile), {operation, part: 0});
        assert.equal(store.reactions.claim(operation.profile), undefined);
        store.reactions.finish(operation.profile, operation.event, 0, 'SENT');
        assert.equal(store.reactions.claim(operation.profile)!.part, 1);
        store.reactions.prepare({...operation, event: '$later', action: 'withdraw'});
        store.reactions.prepare({...operation, event: '$otherchat', chat: 'c:OTHER123'});
        store.close();
        store = new OutboxStore(filename, key);
        store.recoverInterrupted();
        assert.deepEqual(store.reactions.pendingCounts(operation.profile), {
            prepared: 4,
            dispatching: 0,
            uncertain: 1,
            failureNotices: 0,
            retirements: 0,
        });
        assert.deepEqual(store.reactions.pendingCounts('OTHER123'), {
            prepared: 0,
            dispatching: 0,
            uncertain: 0,
            failureNotices: 0,
            retirements: 0,
        });
        assert.deepEqual(store.reactions.get(operation.profile, operation.event)!.states, [
            'SENT',
            'OUTCOME_UNKNOWN',
        ]);
        assert.equal(store.reactions.claim(operation.profile)!.operation.event, '$otherchat');
        assert.equal(store.reactions.claim(operation.profile), undefined);
        assert.throws(() => store.reactions.finish(operation.profile, operation.event, 1, 'SENT'));
        store.rejectEvent(operation.profile, '$rejected', operation.room, 'Previously rejected');
        assert.throws(() => store.reactions.prepare({...operation, event: '$rejected'}));
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('legacy reaction repair preserves multipart reference semantics and restart state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-order-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(filename, key);
    const profile = 'SELF1234';
    const base: ReactionOperation = {
        profile,
        event: '$apply',
        room: '!chat:invalid',
        owner: '@owner:invalid',
        chat: 'c:ABCD1234',
        target: '$text',
        emoji: '👍',
        action: 'apply',
        messages: ['m:0100000000000000', 'm:0200000000000000'],
    };
    const order = ['$apply', '$duplicate', '$withdraw'];
    const source = (event: string) =>
        order.includes(event) ? {transaction: 1, event: order.indexOf(event) + 1} : undefined;
    try {
        store.reactions.prepare({
            ...base,
            event: '$withdraw',
            target: '$apply',
            action: 'withdraw',
        });
        store.reactions.prepare({...base, event: '$duplicate'});
        store.reactions.prepare(base);
        const snapshots = order.map((event) => store.reactions.get(profile, event));
        assert.equal(store.reactions.reorderPrepared(source), 2);
        assert.deepEqual(
            order.map((event) => store.reactions.get(profile, event)),
            snapshots,
        );
        store.close();
        store = new OutboxStore(filename, key);
        assert.equal(store.reactions.reorderPrepared(source), 0);
        for (const event of order) {
            for (let part = 0; part < 2; part++) {
                const next = store.reactions.claim(profile)!;
                assert.equal(next.operation.event, event);
                assert.equal(next.part, part);
                // Duplicate apply and withdrawing just one of two references have no remote effect.
                assert.equal(
                    store.reactions.requiresRemoteMutation(profile, event, part),
                    event === '$apply',
                );
                store.reactions.finish(profile, event, part, 'SENT');
            }
        }
        assert.deepEqual(
            [
                ...store.reactions
                    .activeReferences(profile, base.chat, base.messages[0]!)!
                    .get('👍')!,
            ],
            ['$duplicate'],
        );
        store.reactions.prepare({...base, event: '$missing'});
        assert.equal(store.reactions.reorderPrepared(source), 0);
        store.reactions.claim(profile);
        store.reactions.finish(profile, '$missing', 0, 'OUTCOME_UNKNOWN');
        const before = store.reactions.get(profile, '$missing');
        assert.equal(
            store.reactions.reorderPrepared(() => ({transaction: 1, event: 1})),
            0,
        );
        assert.deepEqual(store.reactions.get(profile, '$missing'), before);
        assert.equal(store.reactions.claim(profile), undefined);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
