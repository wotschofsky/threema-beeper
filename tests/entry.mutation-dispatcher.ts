import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {MutationDispatcher} from '../src/outbox/mutation-dispatcher.ts';
import {BackendWorkerError} from '../src/threema/backend-controller.ts';
import type {MutationOperation} from '../src/outbox/mutation-journal.ts';
await test('mutation dispatch persists attempts, cancels rejected tails and isolates uncertain chats', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-dispatch-')),
        key = randomBytes(32),
        path = join(directory, 'outbox');
    let store = new OutboxStore(path, key);
    const profile = 'SELF1234';
    const plan = (event: string, chat: string): MutationOperation => ({
        profile,
        event,
        chat,
        owner: '@owner:invalid',
        room: '!room:invalid',
        target: '$original',
        commands: [
            {profile, chatId: chat, messageId: 'm:0100000000000000', action: 'edit', text: event},
            {profile, chatId: chat, messageId: 'm:0200000000000000', action: 'delete'},
        ],
    });
    try {
        store.mutations.prepare(plan('$blocked', 'c:AAAA1234'));
        store.mutations.prepare(plan('$unknown', 'c:BBBB1234'));
        store.mutations.prepare(plan('$reject', 'c:CCCC1234'));
        store.mutations.prepare(plan('$ok', 'c:DDDD1234'));
        const calls: string[] = [];
        const dispatcher = new MutationDispatcher({
            profile,
            journal: store.mutations,
            ready: () => true,
            authorize: async (op) => {
                if (op.event === '$blocked') throw new Error('Authorization pending');
                // Authorizers cannot accidentally rewrite the immutable command used by dispatch.
                op.commands[0] = {...op.commands[0]!, messageId: 'm:ffffffffffffffff'};
            },
            backend: {
                mutateMessage: async (command) => {
                    const event =
                        command.chatId === 'c:BBBB1234'
                            ? '$unknown'
                            : command.chatId === 'c:CCCC1234'
                              ? '$reject'
                              : '$ok';
                    const part = command.action === 'edit' ? 0 : 1;
                    assert.equal(store.mutations.get(profile, event)!.states[part], 'DISPATCHING');
                    assert.notEqual(command.messageId, 'm:ffffffffffffffff');
                    calls.push(event + ':' + part);
                    if (event === '$unknown')
                        throw new Error('Lost response after possible application');
                    if (event === '$reject') throw new BackendWorkerError('edit-window-expired');
                },
            },
        });
        const first = dispatcher.drain();
        assert.equal(dispatcher.drain(), first);
        await assert.rejects(first, /pending or uncertain/);
        assert.deepEqual(calls, ['$unknown:0', '$reject:0', '$ok:0', '$ok:1']);
        assert.deepEqual(store.mutations.get(profile, '$blocked')!.states, [
            'PREPARED',
            'PREPARED',
        ]);
        assert.deepEqual(store.mutations.get(profile, '$unknown')!.states, [
            'OUTCOME_UNKNOWN',
            'PREPARED',
        ]);
        assert.deepEqual(store.mutations.get(profile, '$reject')!.states, [
            'REJECTED',
            'CANCELLED',
        ]);
        assert.deepEqual(store.mutations.get(profile, '$ok')!.states, ['APPLIED', 'APPLIED']);
        store.close();
        store = new OutboxStore(path, key);
        store.recoverInterrupted();
        let ready = true,
            invoked = 0;
        const stopped = new MutationDispatcher({
            profile,
            journal: store.mutations,
            ready: () => ready,
            authorize: async () => {
                ready = false;
            },
            backend: {
                mutateMessage: async () => {
                    invoked++;
                },
            },
        });
        assert.equal(await stopped.drain(), 0);
        assert.equal(invoked, 0);
        assert.equal(store.mutations.get(profile, '$blocked')!.states[0], 'PREPARED');
        const resumed = new MutationDispatcher({
            profile,
            journal: store.mutations,
            ready: () => true,
            authorize: async () => {},
            backend: {
                mutateMessage: async () => {
                    invoked++;
                },
            },
        });
        assert.equal(await resumed.drain(), 2);
        assert.equal(invoked, 2);
        assert.equal(await resumed.drain(), 0, 'Unknown and rejected work never replays');
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('failure to commit a successful mutation never makes it eligible for another send', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-commit-')),
        key = randomBytes(32),
        path = join(directory, 'outbox');
    let store = new OutboxStore(path, key),
        calls = 0;
    const profile = 'SELF1234',
        chat = 'c:ABCD1234';
    try {
        store.mutations.prepare({
            profile,
            chat,
            owner: '@owner:invalid',
            room: '!room:invalid',
            event: '$delete',
            target: '$original',
            commands: [{profile, chatId: chat, messageId: 'm:0100000000000000', action: 'delete'}],
        });
        store.mutations.finish = () => {
            throw new Error('Synthetic commit failure');
        };
        const dispatcher = new MutationDispatcher({
            profile,
            journal: store.mutations,
            ready: () => true,
            authorize: async () => {},
            backend: {
                mutateMessage: async () => {
                    calls++;
                },
            },
        });
        await assert.rejects(dispatcher.drain(), /commit failure/);
        assert.equal(store.mutations.get(profile, '$delete')!.states[0], 'DISPATCHING');
        assert.equal(await dispatcher.drain(), 0);
        store.close();
        store = new OutboxStore(path, key);
        store.recoverInterrupted();
        assert.equal(store.mutations.get(profile, '$delete')!.states[0], 'OUTCOME_UNKNOWN');
        const resumed = new MutationDispatcher({
            profile,
            journal: store.mutations,
            ready: () => true,
            authorize: async () => {},
            backend: {
                mutateMessage: async () => {
                    calls++;
                },
            },
        });
        assert.equal(await resumed.drain(), 0);
        assert.equal(calls, 1);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('already deleted parts settle without another mutation after fresh authorization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-noop-delete-')),
        key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox'), key);
    const operation: MutationOperation = {
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!room:invalid',
        chat: 'c:ABCD1234',
        event: '$repeat-delete',
        target: '$original',
        commands: [
            {
                profile: 'SELF1234',
                chatId: 'c:ABCD1234',
                messageId: 'm:0100000000000000',
                action: 'delete',
            },
        ],
    };
    let revoke = true,
        checks = 0,
        lookups = 0,
        ready = true;
    const dispatcher = new MutationDispatcher({
        profile: operation.profile,
        journal: store.mutations,
        ready: () => ready,
        authorize: async () => {
            checks++;
            if (revoke && checks % 2 === 0) throw new Error('Revoked after lookup');
        },
        backend: {
            mutationState: async (request) => {
                lookups++;
                assert.equal(request.action, 'delete');
                return true;
            },
            mutateMessage: async () => {
                assert.fail('Already deleted message must not be deleted again');
            },
        },
    });
    try {
        store.mutations.prepare(operation);
        await assert.rejects(dispatcher.drain());
        assert.deepEqual(store.mutations.get(operation.profile, operation.event)!.states, [
            'PREPARED',
        ]);
        revoke = false;
        ready = false;
        assert.equal(await dispatcher.drain(), 0);
        assert.equal(lookups, 1);
        ready = true;
        assert.equal(await dispatcher.drain(), 1);
        assert.deepEqual(store.mutations.get(operation.profile, operation.event)!.states, [
            'APPLIED',
        ]);
        assert.equal(store.mutations.pendingFailures(operation.profile, 10).length, 0);
        assert.equal(await dispatcher.drain(), 0);
        assert.equal(lookups, 2);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
