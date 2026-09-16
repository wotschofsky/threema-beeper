import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {ReactionFailureNotices} from '../src/outbox/reaction-failure-notices.ts';

await test('reaction failure notices reauthorize and survive restart without changing reply identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-notices-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(filename, key);
    const operation = {
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!chat:invalid',
        event: '$reaction',
        chat: 'c:ABCD1234',
        target: '$text',
        emoji: '👍',
        action: 'apply' as const,
        messages: ['m:0100000000000000'],
    };
    try {
        store.reactions.prepare(operation);
        store.reactions.claim(operation.profile);
        store.reactions.reject(operation.profile, operation.event, 0, 'reaction-not-found');
        assert.equal(store.reactions.pendingCounts(operation.profile).failureNotices, 1);
        let authorized = false,
            failSend = true;
        const sent: unknown[][] = [];
        const worker = () =>
            new ReactionFailureNotices({
                profile: operation.profile,
                journal: store.reactions,
                ready: () => true,
                authorize: async () => {
                    if (!authorized) throw new Error('forbidden');
                },
                send: async (...args) => {
                    sent.push(args);
                    if (failSend) throw new Error('lost reply');
                },
            });
        await assert.rejects(worker().drain());
        assert.equal(sent.length, 0);
        authorized = true;
        await assert.rejects(worker().drain());
        assert.equal(store.reactions.pendingFailures(operation.profile).length, 1);
        store.close();
        store = new OutboxStore(filename, key);
        failSend = false;
        const restarted = worker();
        assert.deepEqual(await Promise.all([restarted.drain(), restarted.drain()]), [1, 1]);
        assert.deepEqual(sent[0], sent[1]);
        const content = sent[1]![2] as Record<string, any>;
        assert.equal(content.msgtype, 'm.notice');
        assert.match(content.body, /part 1 of 1/);
        assert.match(content.body, /missing or deleted/);
        assert.equal(content['m.relates_to']['m.in_reply_to'].event_id, operation.event);
        assert.equal(store.reactions.pendingFailures(operation.profile).length, 0);
        assert.equal(store.reactions.pendingCounts(operation.profile).failureNotices, 0);
        assert.deepEqual(store.reactions.get(operation.profile, operation.event)!.states, [
            'REJECTED',
        ]);
        assert.equal(await restarted.drain(), 0);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('a failed multipart notice does not starve later parts and retries with the same identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-notice-page-'));
    const key = randomBytes(32);
    const store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234',
        event = '$reaction';
    try {
        store.reactions.prepare({
            profile,
            event,
            owner: '@owner:invalid',
            room: '!room:invalid',
            chat: 'c:ABCD1234',
            target: '$text',
            emoji: '👍',
            action: 'apply',
            messages: ['m:0100000000000000', 'm:0200000000000000'],
        });
        for (let part = 0; part < 2; part++) {
            assert.equal(store.reactions.claim(profile)!.part, part);
            store.reactions.reject(profile, event, part, 'reaction-not-found');
        }
        const ids: string[] = [];
        let fail = true;
        const notices = new ReactionFailureNotices({
            profile,
            journal: store.reactions,
            ready: () => true,
            authorize: async () => {},
            send: async (id, _room, content) => {
                ids.push(id);
                if (String(content.body).includes('part 1 of 2') && fail) throw new Error('retry');
            },
        });
        await assert.rejects(notices.drain(1));
        assert.equal(await notices.drain(1), 1);
        assert.equal(store.reactions.pendingFailures(profile).length, 1);
        fail = false;
        assert.equal(await notices.drain(1), 1);
        assert.equal(ids[0], ids[2]);
        assert.notEqual(ids[0], ids[1]);
        assert.equal(store.reactions.pendingFailures(profile).length, 0);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
