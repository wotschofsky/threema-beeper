import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {encodeMessage, decodeMessage} from '../src/threema/message-codec.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

const message: NormalizedNodeMessage = {
    chatId: 'c:TEST1234',
    messageId: 'm:ffffffffffffffff',
    direction: 'outbound',
    senderIdentity: 'SELF1234',
    createdAt: new Date(-123456789),
    ordinal: 9007199254740991n,
    reactions: [{senderIdentity: 'TEST1234', emoji: '👍', reactedAt: new Date(123456789)}],
    content: {type: 'text', text: 'PRIVATE-JOURNAL-TEXT-should-never-appear-in-files'},
};

if (process.argv[2] === '--crash-writer') {
    const input = JSON.parse(readFileSync(0, 'utf8')) as {file: string; key: string};
    const journal = new MessageJournal(input.file, Buffer.from(input.key, 'hex'), 'SELF1234');
    journal.upsert(message);
    process.kill(process.pid, 'SIGKILL');
} else {
    await test('versioned message codec preserves dates/ordinals and rejects unsafe stored representations', () => {
        const encoded = encodeMessage(message);
        assert.deepEqual(decodeMessage(encoded), message);
        assert.equal(
            encodeMessage({
                ...message,
                content: {
                    text: message.content.type === 'text' ? message.content.text : '',
                    type: 'text',
                },
            }),
            encoded,
        );
        for (const change of [
            encoded.replace('"version":1', '"version":2'),
            encoded.replace('"9007199254740991"', '9007199254740991'),
            encoded.replace('"9007199254740991"', '"09007199254740991"'),
            encoded.replace('"createdAt":-123456789', '"createdAt":"2026-01-01"'),
        ])
            assert.throws(() => decodeMessage(change));
    });
    await test('encrypted journal survives abrupt exit and deduplicates replay while retaining edits', () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-journal-'));
        const filename = join(directory, 'messages.sqlite');
        const key = randomBytes(32);
        let journal: MessageJournal | undefined;
        try {
            const child = spawnSync(
                process.execPath,
                [fileURLToPath(import.meta.url), '--crash-writer'],
                {
                    input: JSON.stringify({file: filename, key: key.toString('hex')}),
                    encoding: 'utf8',
                    timeout: 10000,
                },
            );
            assert.equal(child.signal, 'SIGKILL', child.stderr);
            journal = new MessageJournal(filename, key, 'SELF1234');
            assert.deepEqual(
                journal.pending().map((row) => row.message),
                [message],
            );
            assert.equal(journal.upsert(message), 'duplicate');
            assert.equal(
                journal.upsert({
                    ...message,
                    editedAt: new Date(500),
                    content: {type: 'text', text: 'Edited'},
                }),
                'changed',
            );
            const pending = journal.pending();
            assert.equal(pending.length, 2);
            journal.acknowledge(pending[0]!.sequence);
            assert.equal(journal.pending().length, 1);
            const operationId = journal.changeOperationId(pending[1]!.sequence);
            journal.close();
            journal = undefined;
            assert.throws(() => new MessageJournal(filename, randomBytes(32), 'SELF1234'));
            journal = new MessageJournal(filename, key, 'SELF1234');
            assert.equal(journal.pending()[0]!.sequence, pending[1]!.sequence);
            assert.equal(journal.changeOperationId(pending[1]!.sequence), operationId);
            for (const file of readdirSync(directory))
                assert.equal(
                    readFileSync(join(directory, file)).includes(
                        Buffer.from('PRIVATE-JOURNAL-TEXT'),
                    ),
                    false,
                );
            const other = new MessageJournal(filename, key, 'OTHER123');
            try {
                assert.equal(other.pending().length, 0);
                other.acknowledge(pending[1]!.sequence);
            } finally {
                other.close();
            }
            assert.equal(journal.pending().length, 1);
        } finally {
            journal?.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
}
