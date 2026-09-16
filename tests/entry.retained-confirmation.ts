import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {OutboxStore} from '../src/outbox/store.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {reconcileRetainedConfirmations} from '../src/outbox/reconcile-retained.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('retained confirmation traverses shrinking pages, separates quote evidence, and honors cancellation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'retained-confirmation-')),
        key = randomBytes(32);
    const profile = 'SELF1234',
        chat = 'c:TEST1234',
        owner = '@owner:invalid',
        room = '!test:invalid';
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    const journal = new MessageJournal(join(directory, 'journal'), key, profile);
    const texts: string[] = [],
        files: string[] = [];
    function message(index: number, confirmed: boolean): NormalizedNodeMessage {
        return {
            chatId: chat,
            messageId: 'm:' + index.toString(16).padStart(16, '0'),
            direction: 'outbound',
            senderIdentity: profile,
            ordinal: BigInt(index),
            createdAt: new Date(0),
            reactions: [],
            content: {type: 'text', text: 'fixture'},
            ...(confirmed ? {sentAt: new Date(1000)} : {}),
        };
    }
    try {
        for (let i = 0; i < 105; i++) {
            const requestId = createRequestId(),
                event = '$text' + i;
            texts.push(requestId);
            const value = message(i + 1, i !== 100);
            outbox.prepare({
                requestId,
                profile,
                chatId: chat,
                sender: owner,
                roomId: room,
                eventId: event,
                transactionId: event,
                text: 'fixture',
            });
            outbox.claim(requestId);
            outbox.recordIds(requestId, [value.messageId]);
            outbox.sent(requestId, [value.messageId]);
            journal.upsert(value);
            const fileEvent = '$file' + i;
            files.push(fileEvent);
            outbox.media.prepare({
                id: createRequestId(),
                profile,
                owner,
                room,
                event: fileEvent,
                transaction: fileEvent,
                media: {
                    chat,
                    kind: 'm.file',
                    filename: 'fixture.bin',
                    mimeType: 'application/octet-stream',
                    bytes: 3,
                    replyTo: '$original',
                    file: {
                        url: 'mxc://invalid/file',
                        v: 'v2',
                        key: {
                            kty: 'oct',
                            alg: 'A256CTR',
                            key_ops: ['decrypt'],
                            k: Buffer.alloc(32).toString('base64url'),
                        },
                        iv: Buffer.alloc(16).toString('base64'),
                        hashes: {sha256: Buffer.alloc(32).toString('base64')},
                    },
                },
            });
            const quote = message(i + 1000, i !== 100),
                file = message(i + 2000, true);
            file.content = {
                type: 'file',
                fileName: 'fixture.bin',
                mimeType: 'application/octet-stream',
                byteSize: 3,
            };
            outbox.media.prepareReply(profile, fileEvent, 'm:ffffffffffffffff', 'fixture');
            outbox.media.claimReply(profile, fileEvent);
            outbox.media.replyIds(profile, fileEvent, [quote.messageId]);
            outbox.media.replySent(profile, fileEvent, [quote.messageId]);
            outbox.media.claim(profile, fileEvent);
            outbox.media.recordIds(profile, fileEvent, [file.messageId]);
            outbox.media.sent(profile, fileEvent, [file.messageId]);
            journal.upsert(quote);
            journal.upsert(file);
        }
        for (const row of journal.pending(500)) journal.acknowledge(row.sequence);
        outbox.recoverInterrupted();
        await assert.rejects(
            reconcileRetainedConfirmations(profile, outbox, journal, AbortSignal.abort()),
        );
        assert.equal(outbox.get(texts[0]!)?.state, 'OUTCOME_UNKNOWN');
        await reconcileRetainedConfirmations(
            profile,
            outbox,
            journal,
            new AbortController().signal,
        );
        for (let i = 0; i < 105; i++) {
            assert.equal(outbox.get(texts[i]!)?.state, i === 100 ? 'OUTCOME_UNKNOWN' : 'ACKED');
            assert.equal(outbox.media.get(profile, files[i]!)?.state, 'SENT');
            assert.equal(
                outbox.media.reply(profile, files[i]!)?.state,
                i === 100 ? 'OUTCOME_UNKNOWN' : 'SENT',
            );
        }
        assert.equal(outbox.recoveryItems(profile).length, 2);
        assert.equal(outbox.media.pendingCounts(profile).uncertain, 1);
        assert.equal(journal.pending().length, 0);
        await reconcileRetainedConfirmations(
            profile,
            outbox,
            journal,
            new AbortController().signal,
        );
        assert.equal(outbox.recoveryItems(profile).length, 2);
        assert.equal(journal.pending().length, 0);
    } finally {
        outbox.close();
        journal.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
