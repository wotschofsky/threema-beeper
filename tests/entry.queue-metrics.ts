import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {renderMetrics} from '../src/service/metrics.ts';
await test('durable queue counts reflect acknowledgement, restart uncertainty and profile isolation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-queue-metrics-'));
    const key = randomBytes(32);
    const journal = new MessageJournal(join(directory, 'journal'), key, 'SELF1234');
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    let outbox = new OutboxStore(join(directory, 'outbox'), key);
    try {
        assert.equal(journal.pendingCount(), 0);
        journal.upsert({
            chatId: 'c:TEST1234',
            messageId: 'm:0100000000000000',
            senderIdentity: 'SELF1234',
            direction: 'outbound',
            createdAt: new Date(0),
            ordinal: 1n,
            reactions: [],
            content: {type: 'text', text: 'private'},
        });
        assert.equal(journal.pendingCount(), 1);
        journal.acknowledge(journal.pending()[0]!.sequence);
        assert.equal(journal.pendingCount(), 0);
        inbox.accept('txn', {});
        assert.deepEqual(inbox.pendingCounts(), {transactions: 1, events: 0});
        inbox.complete('txn', [
            {
                event_id: '$event',
                room_id: '!room:invalid',
                sender: '@owner:invalid',
                type: 'm.room.message',
                content: {body: 'private'},
            },
        ]);
        assert.deepEqual(inbox.pendingCounts(), {transactions: 0, events: 1});
        inbox.acknowledgeEvent('$event');
        assert.deepEqual(inbox.pendingCounts(), {transactions: 0, events: 0});
        const request = {
            requestId: createRequestId(),
            profile: 'SELF1234',
            transactionId: 'txn',
            eventId: '$event',
            roomId: '!room:invalid',
            sender: '@owner:invalid',
            chatId: 'c:TEST1234',
            text: 'private',
        };
        outbox.prepare(request);
        outbox.prepare({...request, requestId: createRequestId(), profile: 'OTHER123'});
        assert.equal(outbox.pendingCounts('SELF1234').prepared, 1);
        outbox.claim(request.requestId);
        assert.equal(outbox.pendingCounts('SELF1234').dispatching, 1);
        outbox.close();
        outbox = new OutboxStore(join(directory, 'outbox'), key);
        outbox.recoverInterrupted();
        assert.deepEqual(outbox.pendingCounts('SELF1234'), {
            prepared: 0,
            dispatching: 0,
            awaitingEcho: 0,
            uncertain: 1,
        });
        const other = outbox.claim()!;
        assert.equal(other.request.profile, 'OTHER123');
        outbox.recordIds(other.request.requestId, ['m:0200000000000000']);
        outbox.sent(other.request.requestId, ['m:0200000000000000']);
        assert.equal(outbox.pendingCounts('OTHER123').awaitingEcho, 1);
        outbox.observe('OTHER123', request.chatId, 'm:0200000000000000');
        assert.deepEqual(outbox.pendingCounts('OTHER123'), {
            prepared: 0,
            dispatching: 0,
            awaitingEcho: 0,
            uncertain: 0,
        });
        const text = renderMetrics({
            live: true,
            ready: true,
            syncLive: true,
            uptimeSeconds: 0,
            residentBytes: 1,
            queues: {
                journal: journal.pendingCount(),
                ...inbox.pendingCounts(),
                ...outbox.pendingCounts('SELF1234'),
            },
        });
        assert.ok(text.includes('bridge_outbound_uncertain 1\n'));
        assert.ok(!text.includes('SELF1234'));
        assert.ok(!text.includes('private'));
    } finally {
        journal.close();
        inbox.close();
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
