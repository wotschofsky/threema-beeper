import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {ReactionRecovery} from '../src/outbox/reaction-recovery.ts';
await test('uncertain reactions settle only on authorized matching backend state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-recovery-'));
    const key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const operation = {
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!chat:invalid',
        event: '$apply',
        chat: 'c:ABCD1234',
        target: '$text',
        emoji: '👍',
        action: 'apply' as const,
        messages: ['m:0100000000000000'],
    };
    try {
        store.reactions.prepare(operation);
        store.reactions.claim(operation.profile);
        store.recoverInterrupted();
        let present = false,
            authorized = false,
            reads = 0;
        const recovery = new ReactionRecovery({
            profile: operation.profile,
            journal: store.reactions,
            ready: () => true,
            authorize: async () => {
                if (!authorized) throw new Error('denied');
            },
            backend: {
                reactionState: async (request) => {
                    reads++;
                    assert.equal(request.messageId, operation.messages[0]);
                    return present;
                },
            },
        });
        await assert.rejects(recovery.drain());
        assert.equal(reads, 0);
        authorized = true;
        assert.equal(await recovery.drain(), 0);
        assert.deepEqual(store.reactions.get(operation.profile, operation.event)!.states, [
            'OUTCOME_UNKNOWN',
        ]);
        present = true;
        assert.equal(await recovery.drain(), 1);
        assert.deepEqual(store.reactions.get(operation.profile, operation.event)!.states, ['SENT']);
        store.reactions.prepare({
            ...operation,
            event: '$withdraw',
            action: 'withdraw',
            target: '$apply',
        });
        store.reactions.claim(operation.profile);
        store.recoverInterrupted();
        assert.equal(await recovery.drain(), 0);
        present = false;
        assert.equal(await recovery.drain(), 1);
        assert.deepEqual(store.reactions.get(operation.profile, '$withdraw')!.states, ['SENT']);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('bounded recovery reaches later chats despite denied and mismatched predecessors, then wraps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-fairness-'));
    const key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234';
    try {
        for (let i = 0; i < 3; i++) {
            store.reactions.prepare({
                profile,
                owner: '@owner:invalid',
                room: `!room${i}:invalid`,
                event: `$reaction${i}`,
                chat: `c:ABCD123${i}`,
                target: '$text',
                emoji: '👍',
                action: 'apply',
                messages: ['m:0100000000000000'],
            });
            store.reactions.claim(profile);
            store.recoverInterrupted();
        }
        const visited: string[] = [];
        let firstAllowed = false;
        const recovery = new ReactionRecovery({
            profile,
            journal: store.reactions,
            ready: () => true,
            authorize: async (operation) => {
                visited.push(operation.event);
                if (operation.event === '$reaction0' && !firstAllowed) throw new Error('denied');
            },
            backend: {reactionState: async (request) => request.chatId !== 'c:ABCD1231'},
        });
        await assert.rejects(recovery.drain(1));
        assert.equal(await recovery.drain(1), 0);
        assert.equal(await recovery.drain(1), 1);
        assert.deepEqual(visited, ['$reaction0', '$reaction1', '$reaction2']);
        firstAllowed = true;
        assert.equal(await recovery.drain(1), 1);
        assert.deepEqual(visited, ['$reaction0', '$reaction1', '$reaction2', '$reaction0']);
        assert.deepEqual(store.reactions.get(profile, '$reaction1')!.states, ['OUTCOME_UNKNOWN']);
        assert.deepEqual(store.reactions.get(profile, '$reaction2')!.states, ['SENT']);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
