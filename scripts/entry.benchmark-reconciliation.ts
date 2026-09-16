import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, rmSync, statSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {ProfileSynchronizer} from '../src/threema/profile-sync.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

// Synthetic paginated backend; never opens an account or contacts either network.
const worker = process.argv[2] === '--worker';
const total = Number((worker ? process.argv[4] : process.argv[2]) ?? 100000);
assert(Number.isInteger(total) && total >= 100 && total <= 100000 && total % 100 === 0);
const perChat = total / 100;
const chats = Array.from({length: 100}, (_, index) => ({
    chatId: `c:T${index.toString().padStart(7, '0')}`,
    name: `Synthetic chat ${index}`,
    unreadCount: 0,
    archived: false,
    pinned: false,
}));
const fixture = (chatId: string, ordinal: number): NormalizedNodeMessage => ({
    chatId,
    messageId: `m:${ordinal.toString(16).padStart(16, '0')}`,
    direction: 'inbound',
    senderIdentity: chatId.slice(2),
    createdAt: new Date(ordinal * 1000),
    ordinal: BigInt(ordinal),
    reactions: [],
    content: {type: 'text', text: 'Synthetic benchmark content. '.repeat(8) + ordinal},
});
if (!worker) {
    assert(process.argv.length <= 3);
    const directory = mkdtempSync(join(tmpdir(), 'threema-reconciliation-benchmark-'));
    const key = randomBytes(32);
    const rounds = [];
    try {
        writeFileSync(join(directory, 'key'), key, {mode: 0o400, flag: 'wx'});
        for (const round of ['cold', 'warm'] as const) {
            const child = spawnSync(
                process.execPath,
                [
                    ...process.execArgv,
                    fileURLToPath(import.meta.url),
                    '--worker',
                    round,
                    String(total),
                    directory,
                ],
                {encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024},
            );
            if (child.error) throw child.error;
            assert.equal(child.status, 0, `Benchmark ${round} failed: ${child.stderr}`);
            const result = JSON.parse(child.stdout);
            assert.equal(result.round, round);
            assert.equal(result.messages, total);
            assert.equal(result.verifiedMessages, total);
            assert.equal(result.pendingChanges, total);
            rounds.push(result);
            console.log(JSON.stringify(result));
        }
        assert.notEqual(rounds[0].pid, rounds[1].pid, 'Each round needs a fresh process');
        console.log(
            JSON.stringify({
                messages: total,
                chats: chats.length,
                databaseBytes: statSync(join(directory, 'journal.sqlite')).size,
                rounds,
                separateProcesses: true,
                scope: 'Synthetic paginated backend with real encrypted journal and synchronizer; excludes native model loading, Matrix delivery and network latency. Cold means empty bridge journal, not cold OS cache.',
            }),
        );
    } finally {
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
} else {
    assert.equal(process.argv.length, 6);
    const round = process.argv[3];
    assert(round === 'cold' || round === 'warm');
    const directory = process.argv[5]!;
    const key = readFileSync(join(directory, 'key'));
    const journal = new MessageJournal(join(directory, 'journal.sqlite'), key, 'SELF1234');
    assert.equal(
        journal.pendingCount(),
        round === 'cold' ? 0 : total,
        'Unexpected initial journal state',
    );
    try {
        let subscriptions = 0;
        let pages = 0;
        let complete!: () => void;
        let fail!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
            complete = resolve;
            fail = reject;
        });
        const started = performance.now();
        const sync: ProfileSynchronizer = new ProfileSynchronizer(
            {
                directory: async () => ({contacts: [], groups: []}),
                conversations: async () => chats,
                watchTopology: async () => async () => {},
                watchMessages: async () => {
                    subscriptions++;
                    return async () => {
                        subscriptions--;
                    };
                },
                history: async (chatId, limit, after) => {
                    assert.equal(subscriptions, chats.length);
                    assert.equal(sync.readyForMessages, false);
                    const start = after ? Number(after.ordinal) + 1 : 1;
                    const end = Math.min(start + (limit ?? 100) - 1, perChat);
                    const messages = Array.from({length: Math.max(0, end - start + 1)}, (_, n) =>
                        fixture(chatId, start + n),
                    );
                    pages++;
                    return {
                        messages,
                        ...(end < perChat
                            ? {
                                  next: {
                                      ordinal: String(end),
                                      messageId: fixture(chatId, end).messageId,
                                  },
                              }
                            : {}),
                    };
                },
            },
            journal,
            {
                periodicMs: 86400000,
                onState: (state) => {
                    if (state === 'live') complete();
                },
                onError: () => fail(new Error('Synthetic reconciliation failed')),
            },
        );
        try {
            sync.start();
            await ready;
            const durationMs = performance.now() - started;
            assert.equal(
                journal.pendingCount(),
                total,
                'Warm reconciliation must not add duplicate changes',
            );
            for (const chat of chats)
                for (let n = 1; n <= perChat; n++) {
                    const expected = fixture(chat.chatId, n);
                    assert.deepEqual(journal.message(chat.chatId, expected.messageId), expected);
                }
            const maxRssBytes = process.resourceUsage().maxRSS * 1024;
            console.log(
                JSON.stringify({
                    round,
                    messages: total,
                    durationMs: Math.round(durationMs),
                    pages,
                    maxRssBytes,
                    pid: process.pid,
                    verifiedMessages: total,
                    pendingChanges: journal.pendingCount(),
                }),
            );
        } finally {
            await sync.stop();
        }
        assert.equal(subscriptions, 0);
    } finally {
        journal.close();
        key.fill(0);
    }
}
