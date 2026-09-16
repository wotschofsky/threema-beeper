import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {OutboxStore, type TextRequest} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';

const request: TextRequest = {
    requestId: '01900000-0000-7000-8000-000000000001',
    profile: 'SELF1234',
    transactionId: 'kill-point-transaction',
    eventId: '$kill-point',
    roomId: '!room:invalid',
    sender: '@owner:invalid',
    chatId: 'c:TEST1234',
    text: 'synthetic crash fixture',
};
const ids = ['m:ffffffffffffffff', 'm:feffffffffffffff'];
const points = [
    'before-prepare',
    'prepared',
    'checking',
    'claimed',
    'allocated',
    'first-effect',
    'all-effects',
    'sent',
    'acked',
] as const;
// This file is an external synthetic side-effect ledger, never a real remote service.
function effect(directory: string, id: string): void {
    const fd = openSync(join(directory, 'effects'), 'a', 0o600);
    try {
        appendFileSync(fd, `${id}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
function effects(directory: string): string[] {
    const filename = join(directory, 'effects');
    return existsSync(filename)
        ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean)
        : [];
}
if (process.argv[2] === '--child') {
    const directory = process.argv[3]!,
        point = process.argv[4]!;
    const store = new OutboxStore(
        join(directory, 'outbox.sqlite'),
        readFileSync(join(directory, 'key')),
    );
    async function checkpoint(name: string): Promise<void> {
        if (name !== point) return;
        process.send?.({point: name});
        await new Promise<void>(() => {
            setInterval(() => {}, 1000);
        });
    }
    await checkpoint('before-prepare');
    store.prepare(request);
    await checkpoint('prepared');
    const worker = new OutboxWorker(
        store,
        {
            check: async () => checkpoint('checking'),
            send: async (_request, persist) => {
                await checkpoint('claimed');
                await persist(ids);
                await checkpoint('allocated');
                effect(directory, ids[0]!);
                await checkpoint('first-effect');
                effect(directory, ids[1]!);
                await checkpoint('all-effects');
                return ids;
            },
        },
        () => true,
    );
    await worker.flushOne();
    await checkpoint('sent');
    ids.forEach((id) => store.observe(request.profile, request.chatId, id));
    await checkpoint('acked');
    throw new Error('Invalid crash checkpoint');
} else {
    await test(
        'SIGKILL at each outbox boundary never automatically repeats uncertain side effects',
        {timeout: 30_000},
        async (context) => {
            for (const point of points) {
                const directory = mkdtempSync(join(tmpdir(), 'threema-outbox-kill-'));
                const key = randomBytes(32);
                let child: ReturnType<typeof fork> | undefined;
                let exited: Promise<unknown[]> | undefined;
                let store: OutboxStore | undefined;
                try {
                    writeFileSync(join(directory, 'key'), key, {mode: 0o400, flag: 'wx'});
                    child = fork(fileURLToPath(import.meta.url), ['--child', directory, point], {
                        execPath: process.execPath,
                        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                    });
                    exited = once(child, 'exit');
                    const [reported] = await Promise.race([
                        once(child, 'message', {signal: context.signal}),
                        exited.then(() => {
                            throw new Error(`Child exited before ${point}`);
                        }),
                    ]);
                    assert.deepEqual(reported, {point});
                    assert.equal(child.kill('SIGKILL'), true);
                    const [, signal] = await exited;
                    assert.equal(signal, 'SIGKILL');
                    store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
                    store.recoverInterrupted();
                    const safe = ['before-prepare', 'prepared', 'checking'].includes(point);
                    if (point === 'before-prepare')
                        assert.equal(store.get(request.requestId), undefined);
                    // Matrix replay always happens, even for requests whose send outcome is uncertain.
                    const recovered = store.prepare(request);
                    if (safe) assert.equal(recovered.state, 'PREPARED');
                    else
                        assert.equal(
                            recovered.state,
                            point === 'acked' ? 'ACKED' : 'OUTCOME_UNKNOWN',
                        );
                    let sends = 0;
                    const worker = new OutboxWorker(
                        store,
                        {
                            send: async (_request, persist) => {
                                sends++;
                                await persist(ids);
                                ids.forEach((id) => effect(directory, id));
                                return ids;
                            },
                        },
                        () => true,
                    );
                    assert.equal(await worker.flushOne(), safe, point);
                    assert.equal(sends, safe ? 1 : 0, point);
                    const observed = effects(directory);
                    const expectedCount =
                        safe || ['all-effects', 'sent', 'acked'].includes(point)
                            ? 2
                            : point === 'first-effect'
                              ? 1
                              : 0;
                    assert.equal(observed.length, expectedCount, point);
                    assert.equal(
                        new Set(observed).size,
                        observed.length,
                        `Repeated synthetic effect at ${point}`,
                    );
                    // Only actual ledger evidence is reconciled; absent parts remain uncertain.
                    for (const id of [...observed].reverse()) {
                        store.observe(request.profile, request.chatId, id);
                        store.observe(request.profile, request.chatId, id);
                    }
                    if (observed.length === 2)
                        assert.equal(store.get(request.requestId)!.state, 'ACKED');
                    else assert.equal(store.get(request.requestId)!.state, 'OUTCOME_UNKNOWN');
                    assert.equal(await worker.flushOne(), false);
                    assert.equal(sends, safe ? 1 : 0);
                } finally {
                    if (child && child.exitCode === null && child.signalCode === null)
                        child.kill('SIGKILL');
                    if (exited) await exited;
                    store?.close();
                    key.fill(0);
                    rmSync(directory, {recursive: true, force: true});
                }
            }
        },
    );
}
