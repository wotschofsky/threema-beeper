import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {ReactionIngress} from '../src/outbox/reaction-ingress.ts';
import {resolveReactionWithdrawal} from '../src/outbox/reaction-withdrawal.ts';

await test('withdrawals preserve old/new Matrix targets and use only owner reaction mappings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-withdrawal-'));
    const key = randomBytes(32),
        filename = join(directory, 'inbox.sqlite');
    let inbox = new TransactionInbox(filename, key);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!chat:invalid';
    try {
        portals.bind(profile, 'c:ABCD1234', room);
        const base = {room_id: room, sender: owner, type: 'm.room.redaction', content: {}};
        inbox.accept('redactions', {});
        inbox.complete('redactions', [
            {...base, event_id: '$old', redacts: '$reaction'},
            {...base, event_id: '$new', content: {redacts: '$reaction'}},
        ]);
        inbox.close();
        inbox = new TransactionInbox(filename, key);
        assert.equal(inbox.event('$old')!.redacts, '$reaction');
        outbox.reactions.prepare({
            profile,
            owner,
            room,
            event: '$reaction',
            chat: 'c:ABCD1234',
            target: '$text',
            emoji: '👍',
            action: 'apply',
            messages: ['m:0100000000000000'],
        });
        const options = {profile, owner, inbox, outbox, portals};
        assert.equal(new ReactionIngress(options).drain(), 2);
        for (const id of ['$old', '$new']) {
            const saved = outbox.reactions.get(profile, id)!;
            assert.equal(saved.operation.action, 'withdraw');
            assert.equal(saved.operation.target, '$reaction');
            assert.equal(saved.operation.emoji, '👍');
            assert.deepEqual(saved.operation.messages, ['m:0100000000000000']);
        }
        // Withdrawals cannot overtake an unfinished apply.
        assert.equal(outbox.reactions.claim(profile)!.operation.event, '$reaction');
        assert.equal(outbox.reactions.claim(profile), undefined);
        const ambiguous = {
            ...base,
            event_id: '$ambiguous',
            redacts: '$reaction',
            content: {redacts: '$other'},
        };
        assert.equal(resolveReactionWithdrawal(ambiguous, options).kind, 'rejected');
        assert.equal(
            resolveReactionWithdrawal(
                {...base, event_id: '$foreign', sender: '@other:invalid', redacts: '$reaction'},
                options,
            ).kind,
            'ignore',
        );
        assert.equal(
            resolveReactionWithdrawal(
                {...base, event_id: '$message-delete', redacts: '$text'},
                options,
            ).kind,
            'ignore',
        );
        assert.equal(
            resolveReactionWithdrawal(
                {...base, event_id: '$withdraw-withdrawal', redacts: '$old'},
                options,
            ).kind,
            'rejected',
        );
    } finally {
        inbox.close();
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
