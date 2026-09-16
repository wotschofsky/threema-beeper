import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {resolveReactionTarget} from '../src/outbox/reaction-target.ts';

await test('reaction target waits for confirmed sends, scopes mappings and preserves all text parts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-target-'));
    const key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!chat:invalid';
    const event = {
        event_id: '$reaction',
        room_id: room,
        sender: owner,
        encrypted: true,
        type: 'm.reaction',
        content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$message', key: '👍'}},
    };
    const options = {
        outbox,
        profile,
        owner,
        portals: {
            portalForRoom: (target: string) =>
                target === room ? {profile, chat: 'c:ABCD1234'} : undefined,
            messageForEvent: (_profile: string, _chat: string, id: string) =>
                id === '$inbound' ? 'm:0300000000000000' : undefined,
        },
    };
    try {
        const requestId = createRequestId();
        outbox.prepare({
            requestId,
            profile,
            transactionId: 'transaction',
            eventId: '$message',
            roomId: room,
            sender: owner,
            chatId: 'c:ABCD1234',
            text: 'Long text',
        });
        assert.equal(resolveReactionTarget(event, options).kind, 'pending');
        assert.equal(outbox.forEvent('OTHER123', '$message'), undefined);
        outbox.claim(requestId);
        const ids = ['m:0100000000000000', 'm:0200000000000000'];
        outbox.recordIds(requestId, ids);
        assert.equal(resolveReactionTarget(event, options).kind, 'pending');
        outbox.unknown(requestId);
        assert.equal(resolveReactionTarget(event, options).kind, 'pending');
        outbox.observe(profile, 'c:ABCD1234', ids[0]!);
        assert.equal(resolveReactionTarget(event, options).kind, 'pending');
        outbox.observe(profile, 'c:ABCD1234', ids[1]!);
        assert.deepEqual(resolveReactionTarget(event, options), {
            kind: 'resolved',
            chat: 'c:ABCD1234',
            messages: ids,
            emoji: '👍',
            target: '$message',
        });
        assert.equal(
            (
                resolveReactionTarget(
                    {
                        ...event,
                        content: {'m.relates_to': {...event.content['m.relates_to'], key: '👍️'}},
                    },
                    options,
                ) as any
            ).emoji,
            '👍',
        );
        const inbound = {
            ...event,
            content: {'m.relates_to': {...event.content['m.relates_to'], event_id: '$inbound'}},
        };
        assert.deepEqual(resolveReactionTarget(inbound, options), {
            kind: 'resolved',
            chat: 'c:ABCD1234',
            messages: ['m:0300000000000000'],
            emoji: '👍',
            target: '$inbound',
        });
        assert.equal(
            resolveReactionTarget({...event, room_id: '!foreign:invalid'}, options).kind,
            'ignore',
        );
        assert.equal(
            resolveReactionTarget({...event, sender: '@other:invalid'}, options).kind,
            'ignore',
        );
        assert.equal(resolveReactionTarget({...event, encrypted: false}, options).kind, 'resolved');
        assert.equal(
            resolveReactionTarget({...event, content: {'m.relates_to': []}}, options).kind,
            'rejected',
        );
        assert.equal(
            resolveReactionTarget(event, {
                ...options,
                portals: {...options.portals, portalForRoom: () => ({profile, chat: 'c:OTHER123'})},
            }).kind,
            'rejected',
        );
        outbox.rejectEvent(profile, event.event_id, room, 'Previously rejected.');
        assert.deepEqual(resolveReactionTarget(event, options), {
            kind: 'rejected',
            reason: 'Previously rejected.',
        });
    } finally {
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
