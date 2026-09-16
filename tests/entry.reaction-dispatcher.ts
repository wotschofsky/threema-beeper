import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {ReactionDispatcher} from '../src/outbox/reaction-dispatcher.ts';
import type {ReactionOperation} from '../src/outbox/reaction-journal.ts';

await test('reaction dispatch separates preflight failure from uncertain sends and continues unrelated chats', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-dispatcher-'));
    const key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234';
    const base: ReactionOperation = {
        profile,
        event: '$blocked',
        room: '!room:invalid',
        owner: '@owner:invalid',
        chat: 'c:ABCD1234',
        target: '$target',
        emoji: '👍',
        action: 'apply',
        messages: ['m:0100000000000000'],
    };
    try {
        store.reactions.prepare(base);
        store.reactions.prepare({...base, event: '$uncertain', chat: 'c:OTHER123'});
        store.reactions.prepare({...base, event: '$later', chat: 'c:OTHER123', action: 'withdraw'});
        store.reactions.prepare({...base, event: '$ok', chat: 'c:FINAL123'});
        let allow = false,
            ready = true;
        const sent: string[] = [];
        const dispatcher = new ReactionDispatcher({
            profile,
            journal: store.reactions,
            ready: () => ready,
            authorize: async (operation) => {
                if (operation.event === '$blocked' && !allow) throw new Error('membership');
            },
            backend: {
                reactMessage: async (request) => {
                    const id =
                        request.chatId === base.chat
                            ? '$blocked'
                            : request.chatId === 'c:OTHER123'
                              ? '$uncertain'
                              : '$ok';
                    assert.equal(store.reactions.get(profile, id)!.states[0], 'DISPATCHING');
                    sent.push(request.chatId);
                    if (request.chatId === 'c:OTHER123') throw new Error('lost response');
                },
            },
        });
        await assert.rejects(dispatcher.drain());
        assert.deepEqual(sent, ['c:OTHER123', 'c:FINAL123']);
        assert.deepEqual(store.reactions.get(profile, '$blocked')!.states, ['PREPARED']);
        assert.deepEqual(store.reactions.get(profile, '$uncertain')!.states, ['OUTCOME_UNKNOWN']);
        assert.deepEqual(store.reactions.get(profile, '$later')!.states, ['PREPARED']);
        assert.deepEqual(store.reactions.get(profile, '$ok')!.states, ['SENT']);
        allow = true;
        ready = false;
        assert.equal(await dispatcher.drain(), 0);
        ready = true;
        assert.deepEqual(await Promise.all([dispatcher.drain(), dispatcher.drain()]), [1, 1]);
        assert.equal(sent.length, 3);
        assert.equal(await dispatcher.drain(), 0);
        assert.deepEqual(store.reactions.get(profile, '$later')!.states, ['PREPARED']);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('duplicate Matrix reactions retain Threema emoji until the final reference is removed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-references-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(filename, key);
    const base: ReactionOperation = {
        profile: 'SELF1234',
        event: '$first',
        room: '!room:invalid',
        owner: '@owner:invalid',
        chat: 'c:ABCD1234',
        target: '$text',
        emoji: '👍',
        action: 'apply',
        messages: ['m:0100000000000000'],
    };
    try {
        for (const operation of [
            base,
            {...base, event: '$second'},
            {...base, event: '$remove-first', action: 'withdraw' as const, target: '$first'},
            {...base, event: '$remove-first-again', action: 'withdraw' as const, target: '$first'},
            {...base, event: '$remove-second', action: 'withdraw' as const, target: '$second'},
            {...base, event: '$third'},
        ])
            store.reactions.prepare(operation);
        const calls: string[] = [];
        const worker = () =>
            new ReactionDispatcher({
                profile: base.profile,
                journal: store.reactions,
                ready: () => true,
                authorize: async () => {},
                backend: {
                    reactMessage: async (request) => {
                        calls.push(request.action);
                    },
                },
            });
        assert.equal(await worker().drain(1), 1);
        assert.deepEqual(calls, ['apply']);
        assert.equal(await worker().drain(1), 1);
        assert.deepEqual(calls, ['apply']);
        store.close();
        store = new OutboxStore(filename, key);
        assert.equal(await worker().drain(1), 1);
        assert.equal(await worker().drain(1), 1);
        assert.deepEqual(calls, ['apply']);
        assert.equal(await worker().drain(1), 1);
        assert.deepEqual(calls, ['apply', 'withdraw']);
        assert.equal(await worker().drain(1), 1);
        assert.deepEqual(calls, ['apply', 'withdraw', 'apply']);
        assert.equal(await worker().drain(), 0);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('definite rejection releases the chat and does not create an active emoji reference', async () => {
    const {BackendWorkerError} = await import('../src/threema/backend-controller.ts');
    const directory = mkdtempSync(join(tmpdir(), 'reaction-rejected-'));
    const key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const base: ReactionOperation = {
        profile: 'SELF1234',
        event: '$rejected',
        room: '!room:invalid',
        owner: '@owner:invalid',
        chat: 'c:ABCD1234',
        target: '$text',
        emoji: '👍',
        action: 'apply',
        messages: ['m:0100000000000000'],
    };
    try {
        store.reactions.prepare(base);
        store.reactions.prepare({...base, event: '$accepted'});
        store.reactions.prepare({
            ...base,
            event: '$remove',
            action: 'withdraw',
            target: '$accepted',
        });
        const calls: string[] = [];
        const worker = new ReactionDispatcher({
            profile: base.profile,
            journal: store.reactions,
            ready: () => true,
            authorize: async () => {},
            backend: {
                reactMessage: async (request) => {
                    calls.push(request.action);
                    if (calls.length === 1)
                        throw new BackendWorkerError('reaction-permission-denied');
                },
            },
        });
        assert.equal(await worker.drain(), 3);
        assert.deepEqual(calls, ['apply', 'apply', 'withdraw']);
        assert.deepEqual(store.reactions.get(base.profile, '$rejected')!.states, ['REJECTED']);
        assert.deepEqual(store.reactions.get(base.profile, '$accepted')!.states, ['SENT']);
        assert.deepEqual(store.reactions.get(base.profile, '$remove')!.states, ['SENT']);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
