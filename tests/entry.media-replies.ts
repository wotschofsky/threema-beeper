import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {createMediaReply} from '../src/outbox/media-reply.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
for (const kind of ['m.file', 'm.image'] as const)
    for (const outcome of ['lost-response', 'accepted', 'legacy-accepted'] as const)
        await test(`${kind} quote companion recovers ${outcome} without duplication or crossing chats`, async () => {
            const directory = mkdtempSync(join(tmpdir(), 'media-reply-')),
                key = randomBytes(32),
                file = join(directory, 'outbox.sqlite');
            let outbox = new OutboxStore(file, key);
            const portals = new PortalStore(join(directory, 'portals.sqlite'), key),
                inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
            const profile = 'SELF1234',
                owner = '@owner:invalid',
                room = '!room:invalid',
                chat = 'c:ECHOECHO',
                target = 'm:0100000000000000',
                quote = 'm:0200000000000000';
            const request: MediaRequest = {
                id: createRequestId(),
                profile,
                owner,
                room,
                event: '$attachment',
                transaction: 'test',
                media: {
                    chat,
                    kind,
                    filename: 'test.png',
                    mimeType: kind === 'm.file' ? 'application/octet-stream' : 'image/png',
                    replyTo: '$original',
                    bytes: 3,
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
            };
            let calls = 0;
            const options = () => ({
                profile,
                owner,
                portals,
                inbox,
                outbox,
                ready: () => true,
                send: async (command: any, persist: any) => {
                    calls++;
                    assert.equal(command.chatId, chat);
                    assert.equal(command.replyTo, target);
                    await persist([quote]);
                    if (outcome === 'lost-response') throw Error('lost response');
                    return [quote];
                },
            });
            try {
                portals.bind(profile, chat, room);
                portals.bindOwnerEcho({
                    profile,
                    chat,
                    room,
                    message: target,
                    sender: owner,
                    root: '$original',
                    latest: '$original',
                    digest: 'fixture',
                });
                outbox.media.prepare(request);
                if (outcome === 'lost-response')
                    await assert.rejects(createMediaReply(options())(request));
                else await createMediaReply(options())(request);
                if (kind === 'm.file' && outcome === 'accepted') {
                    // The attachment can be confirmed independently of its quote companion.
                    const id = 'm:0300000000000000';
                    outbox.media.claim(profile, request.event);
                    outbox.media.recordIds(profile, request.event, [id]);
                    outbox.media.sent(profile, request.event, [id]);
                    outbox.media.observe(profile, chat, id);
                }
                outbox.close();
                if (outcome === 'legacy-accepted') {
                    const {default: Database} = await import(
                        '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js'
                    );
                    const legacy = new Database(file);
                    try {
                        legacy.pragma('cipher_compatibility=4');
                        legacy.pragma(`key = "x'${key.toString('hex')}'"`);
                        const columns = legacy
                            .prepare('PRAGMA table_info(media_replies)')
                            .all() as {name: string}[];
                        if (columns.some((c) => c.name === 'observed'))
                            legacy.exec('ALTER TABLE media_replies DROP COLUMN observed');
                        legacy.pragma('user_version=16');
                    } finally {
                        legacy.close();
                    }
                }
                outbox = new OutboxStore(file, key);
                outbox.recoverInterrupted();
                assert.equal(outbox.recoveryItems(profile)[0]?.state, 'OUTCOME_UNKNOWN');
                assert.equal(outbox.media.pendingCounts(profile).uncertain, 1);
                assert.equal(outbox.media.pendingCounts(profile).prepared, 0);
                outbox.retryPrepared(profile);
                await assert.rejects(createMediaReply(options())(request), /uncertain/);
                assert.equal(calls, 1);
                assert.equal(outbox.media.observeReply(profile, 'c:OTHER123', quote, true), false);
                assert.equal(outbox.media.observeReply(profile, chat, quote, false), true);
                assert.equal(outbox.media.reply(profile, request.event)?.state, 'OUTCOME_UNKNOWN');
                assert.equal(outbox.media.observeReply(profile, chat, quote, true), true);
                outbox.close();
                outbox = new OutboxStore(file, key);
                outbox.recoverInterrupted();
                assert.equal(outbox.media.reply(profile, request.event)?.state, 'SENT');
                assert.equal(outbox.media.pendingCounts(profile).uncertain, 0);
                await createMediaReply(options())(request);
                assert.equal(calls, 1);
                assert.equal(
                    outbox.media.get(profile, request.event)?.state,
                    kind === 'm.file' && outcome === 'accepted' ? 'SENT' : 'PREPARED',
                    'Quote confirmation preserves the independent attachment state',
                );
            } finally {
                outbox.close();
                portals.close();
                inbox.close();
                key.fill(0);
                rmSync(directory, {recursive: true, force: true});
            }
        });
