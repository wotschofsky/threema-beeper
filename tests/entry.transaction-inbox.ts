import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {TransactionInbox, TransactionConflictError} from '../src/matrix/transaction-inbox.ts';

const event = {
    event_id: '$synthetic',
    room_id: '!synthetic:example.invalid',
    sender: '@synthetic:example.invalid',
    type: 'm.room.message',
    content: {body: 'synthetic-private-message'},
};
if (process.argv[2] === '--child') {
    const directory = process.argv[3]!;
    const inbox = new TransactionInbox(
        join(directory, 'inbox.sqlite'),
        readFileSync(join(directory, 'key')),
    );
    inbox.accept('synthetic-transaction', {events: [event]});
    process.send?.('committed');
    setInterval(() => undefined, 1000);
} else {
    await test(
        'committed inbox survives SIGKILL, deduplicates retries and atomically publishes events',
        {timeout: 30000},
        async (context) => {
            const directory = mkdtempSync(join(tmpdir(), 'threema-inbox-'));
            const key = randomBytes(32);
            let child: ReturnType<typeof fork> | undefined;
            let inbox: TransactionInbox | undefined;
            try {
                writeFileSync(join(directory, 'key'), key, {mode: 0o400, flag: 'wx'});
                child = fork(fileURLToPath(import.meta.url), ['--child', directory], {
                    execPath: process.execPath,
                    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                });
                const exited = once(child, 'exit');
                await Promise.race([
                    once(child, 'message', {signal: context.signal}),
                    exited.then(() => {
                        throw new Error('Child exited before commit');
                    }),
                ]);
                child.kill('SIGKILL');
                await exited;
                inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
                assert.equal(inbox.next()?.id, 'synthetic-transaction');
                assert.equal(inbox.accept('synthetic-transaction', {events: [event]}), 'duplicate');
                assert.throws(
                    () => inbox!.accept('synthetic-transaction', {events: []}),
                    TransactionConflictError,
                );
                inbox.recordAttempt('synthetic-transaction');
                assert.equal(inbox.next()?.attempts, 1);
                assert.throws(() =>
                    inbox!.complete('synthetic-transaction', [
                        event,
                        {...event, content: {body: 'conflict'}},
                    ]),
                );
                assert.equal(
                    inbox.pendingEvents().length,
                    0,
                    'Failed commit must roll back all event writes',
                );
                assert.ok(inbox.next());
                inbox.complete('synthetic-transaction', [event]);
                assert.equal(inbox.next(), undefined);
                inbox.accept('retry-event-in-different-transaction', {events: [event]});
                inbox.complete('retry-event-in-different-transaction', [event]);
                assert.deepEqual(inbox.pendingEvents(), [event]);
                inbox.close();
                inbox = undefined;
                assert.ok(
                    !readFileSync(join(directory, 'inbox.sqlite')).includes(
                        Buffer.from(event.content.body),
                    ),
                );
                assert.throws(
                    () => new TransactionInbox(join(directory, 'inbox.sqlite'), randomBytes(32)),
                );
                inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
                assert.equal(inbox.accept('synthetic-transaction', {events: [event]}), 'duplicate');
                assert.deepEqual(inbox.pendingEvents(), [event]);
            } finally {
                child?.kill('SIGKILL');
                inbox?.close();
                key.fill(0);
                rmSync(directory, {recursive: true, force: true});
            }
        },
    );
}
