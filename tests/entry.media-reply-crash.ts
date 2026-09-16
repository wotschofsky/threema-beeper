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
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {createMediaReply} from '../src/outbox/media-reply.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';

const profile = 'SELF1234',
    owner = '@owner:invalid',
    room = '!reply:invalid',
    chat = 'c:TEST1234';
const target = 'm:0100000000000000',
    quote = 'm:0200000000000000',
    attachment = 'm:0300000000000000';
const points = [
    'before-dispatch',
    'quote-claimed',
    'quote-allocated',
    'quote-effect',
    'quote-sent',
    'attachment-effect',
    'sent',
] as const;
function request(kind: 'm.file' | 'm.image'): MediaRequest {
    return {
        id: '01900000-0000-7000-8000-000000000001',
        profile,
        owner,
        room,
        event: '$attachment',
        transaction: 'fixture',
        media: {
            chat,
            kind,
            filename: 'fixture.png',
            mimeType: 'image/png',
            bytes: 12,
            replyTo: '$original',
            file: {
                url: 'mxc://invalid/fixture',
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
    };
}
function effects(directory: string): string[] {
    const path = join(directory, 'effects');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}
function effect(directory: string, id: string): void {
    const fd = openSync(join(directory, 'effects'), 'a', 0o600);
    try {
        appendFileSync(fd, id + '\n');
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
function resources(directory: string, key: Buffer) {
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    return {
        outbox,
        portals,
        inbox,
        close() {
            outbox.close();
            portals.close();
            inbox.close();
        },
    };
}
function worker(
    r: ReturnType<typeof resources>,
    directory: string,
    checkpoint: (name: string) => Promise<void>,
) {
    const reply = createMediaReply({
        profile,
        owner,
        ...r,
        ready: () => true,
        send: async (command, persist) => {
            assert.equal(command.replyTo, target);
            assert.equal(command.chatId, chat);
            await checkpoint('quote-claimed');
            await persist!([quote]);
            await checkpoint('quote-allocated');
            effect(directory, quote);
            await checkpoint('quote-effect');
            return [quote];
        },
    });
    const command = {
        profile,
        chatId: chat,
        token: 'a'.repeat(64),
        fileName: 'fixture.png',
        mediaType: 'image/png',
    };
    const discard = async () => {};
    const send = async (_command: unknown, persist: (ids: readonly string[]) => Promise<void>) => {
        await persist([attachment]);
        effect(directory, attachment);
        await checkpoint('attachment-effect');
        return [attachment];
    };
    const metadata = {
        fileName: 'fixture.png',
        mediaType: 'image/png' as const,
        width: 2,
        height: 2,
        thumbnailMediaType: 'image/png' as const,
        thumbnailWidth: 1,
        thumbnailHeight: 1,
    };
    return new MediaDispatcher({
        profile,
        journal: r.outbox.media,
        ready: () => true,
        authorize: async () => {},
        reply: async (value) => {
            await reply(value);
            await checkpoint('quote-sent');
        },
        backend: {sendPreparedFile: send},
        prepare: async () => ({request: command, discard}),
        images: {
            send,
            prepare: async () => ({
                request: {...command, ...metadata, thumbnailToken: 'b'.repeat(64)},
                projection: {kind: 'image', ...metadata, bytes: 12, thumbnailBytes: 6},
                discard,
            }),
        },
    });
}
if (process.argv[2] === '--child') {
    const directory = process.argv[3]!,
        point = process.argv[4]!;
    const r = resources(directory, readFileSync(join(directory, 'key')));
    const checkpoint = async (name: string) => {
        if (name !== point) return;
        process.send?.({point: name});
        await new Promise<void>(() => {
            setInterval(() => {}, 1000);
        });
    };
    await checkpoint('before-dispatch');
    await worker(r, directory, checkpoint).drain();
    await checkpoint('sent');
    throw Error('Checkpoint was not reached');
} else
    for (const kind of ['m.file', 'm.image'] as const)
        await test(
            `SIGKILL ${kind} reply and attachment recover independently`,
            {timeout: 90_000},
            async (context) => {
                for (const point of points) {
                    const directory = mkdtempSync(join(tmpdir(), 'reply-kill-')),
                        key = randomBytes(32),
                        value = request(kind);
                    let r: ReturnType<typeof resources> | undefined,
                        child: ReturnType<typeof fork> | undefined,
                        exited: Promise<unknown[]> | undefined;
                    try {
                        writeFileSync(join(directory, 'key'), key, {mode: 0o400, flag: 'wx'});
                        r = resources(directory, key);
                        r.portals.bind(profile, chat, room);
                        r.portals.bindOwnerEcho({
                            profile,
                            chat,
                            room,
                            message: target,
                            sender: owner,
                            root: '$original',
                            latest: '$original',
                            digest: 'fixture',
                        });
                        r.outbox.media.prepare(value);
                        r.close();
                        r = undefined;
                        child = fork(
                            fileURLToPath(import.meta.url),
                            ['--child', directory, point],
                            {
                                execPath: process.execPath,
                                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                            },
                        );
                        exited = once(child, 'exit');
                        const [reported] = await Promise.race([
                            once(child, 'message', {signal: context.signal}),
                            exited.then(() => {
                                throw Error('Child exited before ' + point);
                            }),
                        ]);
                        assert.deepEqual(reported, {point});
                        assert(child.kill('SIGKILL'));
                        assert.equal((await exited)[1], 'SIGKILL');
                        r = resources(directory, key);
                        r.outbox.recoverInterrupted();
                        r.outbox.media.prepare(value);
                        let invocations = 0;
                        const run = worker(r, directory, async (name) => {
                            if (name === 'quote-claimed' || name === 'attachment-effect')
                                invocations++;
                        });
                        const blockedQuote = [
                            'quote-claimed',
                            'quote-allocated',
                            'quote-effect',
                            'quote-sent',
                        ].includes(point);
                        if (blockedQuote) {
                            assert.equal(
                                r.outbox.media.reply(profile, value.event)?.state,
                                'OUTCOME_UNKNOWN',
                            );
                            assert.equal(
                                r.outbox.recoveryItems(profile)[0]?.state,
                                'OUTCOME_UNKNOWN',
                            );
                        }
                        const before = effects(directory);
                        if (blockedQuote)
                            await assert.rejects(
                                run.drain(),
                                /Media work remains pending or uncertain/,
                            );
                        else await run.drain();
                        assert.equal(invocations, point === 'before-dispatch' ? 2 : 0);
                        for (const id of [...before].reverse()) {
                            for (let duplicate = 0; duplicate < 2; duplicate++) {
                                if (id === quote) {
                                    assert.equal(
                                        r.outbox.media.observeReply(
                                            profile,
                                            'c:OTHER123',
                                            id,
                                            true,
                                        ),
                                        false,
                                    );
                                    assert.equal(
                                        r.outbox.media.observeReply(profile, chat, id, true),
                                        true,
                                    );
                                } else r.outbox.media.observe(profile, chat, id);
                            }
                        }
                        // A confirmed quote can release the still-unclaimed attachment, but never resend the quote.
                        r.outbox.retryPrepared(profile);
                        await run.drain();
                        const unresolved = ['quote-claimed', 'quote-allocated'].includes(point);
                        const all = effects(directory);
                        assert.equal(all.filter((id) => id === quote).length, unresolved ? 0 : 1);
                        assert.equal(
                            all.filter((id) => id === attachment).length,
                            unresolved ? 0 : 1,
                        );
                        assert.equal(new Set(all).size, all.length);
                        assert.equal(
                            r.outbox.media.reply(profile, value.event)?.state,
                            unresolved ? 'OUTCOME_UNKNOWN' : 'SENT',
                        );
                        assert.equal(
                            r.outbox.media.get(profile, value.event)?.state,
                            unresolved ? 'PREPARED' : 'SENT',
                        );
                        const calls = invocations;
                        await run.drain();
                        assert.equal(invocations, calls);
                        context.diagnostic(
                            `${kind}/${point}: quote and attachment have no duplicate effects`,
                        );
                    } finally {
                        if (child && child.exitCode === null && child.signalCode === null)
                            child.kill('SIGKILL');
                        if (exited) await exited;
                        r?.close();
                        key.fill(0);
                        rmSync(directory, {recursive: true, force: true});
                    }
                }
            },
        );
