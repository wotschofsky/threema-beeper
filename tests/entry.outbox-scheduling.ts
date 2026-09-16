import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {OutboxStore, type TextRequest} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
function request(chatId: string, eventId: string): TextRequest {
    return {
        requestId: createRequestId(),
        profile: 'SELF1234',
        transactionId: eventId,
        eventId,
        roomId: '!room:invalid',
        sender: '@owner:invalid',
        chatId,
        text: 'fixture',
    };
}
await test('preflight retry deadlines survive restart and do not block other chats or reorder the affected chat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-outbox-schedule-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    let store = new OutboxStore(filename, key);
    const first = request('c:TEST1234', '$first'),
        second = request('c:TEST1234', '$second'),
        other = request('c:OTHER123', '$other');
    let now = 10_000,
        fail = true;
    const sent: string[] = [];
    const make = () =>
        new OutboxWorker(
            store,
            {
                check: async (value) => {
                    if (value.requestId === first.requestId && fail)
                        throw new Error('synthetic preflight failure');
                },
                send: async (value, persist) => {
                    const ids = [`m:${(sent.length + 1).toString(16).padStart(16, '0')}`];
                    await persist(ids);
                    sent.push(value.eventId);
                    return ids;
                },
            },
            () => true,
            {now: () => now, retryDelayMs: 100},
        );
    try {
        [first, second, other].forEach((value) => store.prepare(value));
        let worker = make();
        await assert.rejects(worker.flushOne(), /preflight failure/);
        assert.equal(store.get(first.requestId)!.retryAt, 10_100);
        assert.equal(await worker.flushOne(), true);
        assert.deepEqual(sent, ['$other']);
        assert.equal(await worker.flushOne(), false);
        store.close();
        store = new OutboxStore(filename, key);
        worker = make();
        assert.equal(store.get(first.requestId)!.preflightFailures, 1);
        assert.equal(await worker.flushOne(), false);
        now = 10_100;
        await assert.rejects(worker.flushOne(), /preflight failure/);
        assert.equal(store.get(first.requestId)!.retryAt, 10_300);
        now = 10_299;
        assert.equal(await worker.flushOne(), false);
        now = 10_300;
        fail = false;
        assert.equal(await worker.flushOne(), true);
        assert.equal(await worker.flushOne(), true);
        assert.deepEqual(sent, ['$other', '$first', '$second']);
        const uncertain = request('c:TEST1234', '$uncertain'),
            queued = request('c:TEST1234', '$queued'),
            independent = request('c:OTHER123', '$independent');
        [uncertain, queued, independent].forEach((value) => store.prepare(value));
        assert.equal(store.claim(undefined, now)!.request.requestId, uncertain.requestId);
        store.recoverInterrupted();
        assert.equal(store.nextPrepared(now), undefined, 'Both chats have unconfirmed prior sends');
        store.observe(other.profile, other.chatId, store.get(other.requestId)!.ids[0]!);
        assert.equal(store.nextPrepared(now)!.request.requestId, independent.requestId);
        assert.equal(await worker.flushOne(), true);
        assert.equal(await worker.flushOne(), false);
        store.deferPreflight(uncertain.requestId, 0);
        assert.equal(store.get(uncertain.requestId)!.state, 'OUTCOME_UNKNOWN');
        assert.equal(store.nextPrepared(now), undefined);
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
await test('schema 1 outbox migration retains requests and initializes safe retry metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-outbox-migrate-'));
    const key = randomBytes(32),
        filename = join(directory, 'outbox.sqlite');
    const {default: Database} = await import(
        '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js'
    );
    const legacy = new Database(filename);
    legacy.pragma('cipher_compatibility=4');
    legacy.pragma(`key = "x'${key.toString('hex')}'"`);
    legacy.exec(
        `CREATE TABLE requests(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,profile TEXT NOT NULL,event TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(profile,event)); PRAGMA user_version=1;`,
    );
    const value = request('c:TEST1234', '$legacy');
    legacy
        .prepare(
            "INSERT INTO requests(id,profile,event,digest,body,created,state) VALUES(?,?,?,?,?,0,'PREPARED')",
        )
        .run(value.requestId, value.profile, value.eventId, 'legacy', JSON.stringify(value));
    legacy.close();
    const store = new OutboxStore(filename, key);
    try {
        const row = store.nextPrepared(0)!;
        assert.deepEqual(row.request, value);
        assert.equal(row.retryAt, 0);
        assert.equal(row.preflightFailures, 0);
        assert.equal(store.claim(undefined, 0)!.request.requestId, value.requestId);
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
