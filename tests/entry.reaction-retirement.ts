import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {retireAbsentReaction} from '../src/outbox/reaction-retirement.ts';
await test('phone removal retires only after all parts are absent and retries the same redaction after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-retirement-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(filename, key);
    const op = {
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!chat:invalid',
        event: '$apply',
        chat: 'c:ABCD1234',
        target: '$text',
        emoji: '👍',
        action: 'apply' as const,
        messages: ['m:0100000000000000', 'm:0200000000000000'],
    };
    try {
        store.reactions.prepare(op);
        let present = true,
            failSend = true,
            reads = 0;
        const sent: string[][] = [];
        const options = () => ({
            journal: store.reactions,
            ready: () => true,
            authorize: async () => {},
            backend: {
                reactionState: async () => {
                    reads++;
                    return present;
                },
            },
            redact: async (...args: string[]) => {
                sent.push(args);
                if (failSend) throw new Error('lost reply');
            },
        });
        assert.equal(await retireAbsentReaction(op.profile, op.event, options()), false);
        assert.equal(reads, 0);
        for (let part = 0; part < 2; part++) {
            store.reactions.claim(op.profile);
            store.reactions.finish(op.profile, op.event, part, 'SENT');
        }
        assert.equal(await retireAbsentReaction(op.profile, op.event, options()), false);
        assert.equal(sent.length, 0);
        present = false;
        await assert.rejects(retireAbsentReaction(op.profile, op.event, options()));
        assert.deepEqual(store.reactions.retirement(op.profile, op.event), {done: false});
        assert.equal(
            store.reactions.activeReferences(op.profile, op.chat, op.messages[0]!).size,
            0,
        );
        store.close();
        store = new OutboxStore(filename, key);
        failSend = false;
        const previousReads = reads;
        assert.equal(await retireAbsentReaction(op.profile, op.event, options()), true);
        assert.equal(
            reads,
            previousReads,
            'A durable redaction plan must complete even after state changes',
        );
        assert.deepEqual(sent[0], sent[1]);
        assert.deepEqual(store.reactions.retirement(op.profile, op.event), {done: true});
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('retirement cursor advances past present reactions and wraps without starving later entries', async () => {
    const {ReactionRetirementWorker} = await import('../src/outbox/reaction-retirement.ts');
    const directory = mkdtempSync(join(tmpdir(), 'reaction-retirement-page-'));
    const key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234';
    try {
        for (const [event, chat] of [['$first', 'c:FIRST123'], ['$second', 'c:OTHER123']]) {
            store.reactions.prepare({profile, event: event!, chat: chat!, owner: '@owner:invalid', room: '!room:invalid', target: '$text',
                emoji: '👍', action: 'apply', messages: ['m:0100000000000000']});
            store.reactions.claim(profile); store.reactions.finish(profile, event!, 0, 'SENT');
        }
        const removed: string[] = [];
        const worker = new ReactionRetirementWorker(profile, {journal: store.reactions, ready: () => true, authorize: async () => {},
            backend: {reactionState: async request => request.chatId === 'c:FIRST123'},
            redact: async (_id, _room, event) => {removed.push(event);},
        });
        assert.equal(await worker.drain(1), 0);
        assert.equal(await worker.drain(1), 1);
        assert.deepEqual(removed, ['$second']);
        assert.equal(await worker.drain(1), 0);
    } finally {store.close(); key.fill(0); rmSync(directory, {recursive: true, force: true});}
});
