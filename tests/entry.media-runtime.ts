import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {createMediaRuntime} from '../src/outbox/media-runtime.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
for (const kind of ['m.file', 'm.video'] as const)
    await test(`${kind} runtime waits for text and rechecks room authorization after preparation`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'media-runtime-')),
            key = randomBytes(32);
        const inbox = new TransactionInbox(join(directory, 'inbox'), key);
        const outbox = new OutboxStore(join(directory, 'outbox'), key);
        const portals = new PortalStore(join(directory, 'portals'), key);
        const profile = 'SELF1234',
            owner = '@owner:invalid',
            room = '!room:invalid',
            chat = 'c:ABCD1234';
        let joined = true,
            revoke = true,
            prepared = 0,
            discarded = 0,
            sent = 0,
            ready = true;
        const runtime = createMediaRuntime({
            profile,
            owner,
            inbox,
            outbox,
            portals,
            maximumBytes: 1024,
            ready: () => ready,
            bot: {
                userId: '@bot:invalid',
                underlyingClient: {
                    getRoomState: async () =>
                        [
                            {
                                type: 'm.room.encryption',
                                state_key: '',
                                content: {algorithm: 'm.megolm.v1.aes-sha2'},
                            },
                            {
                                type: 'm.bridge',
                                state_key: 'threema://bridge',
                                sender: '@bot:invalid',
                                content: {
                                    creator: owner,
                                    network: {id: profile},
                                    channel: {id: chat},
                                },
                            },
                            {
                                type: 'm.room.member',
                                state_key: owner,
                                content: {membership: joined ? 'join' : 'leave'},
                            },
                        ].map((event, index) => ({
                            event_id: `$state${index}`,
                            origin_server_ts: 0,
                            room_id: room,
                            unsigned: {},
                            sender: '@bot:invalid',
                            ...event,
                        })),
                },
            },
            prepare: async () => {
                prepared++;
                if (revoke) joined = false;
                return {
                    request: {
                        profile,
                        chatId: chat,
                        token: 'a'.repeat(64),
                        fileName: 'fixture.bin',
                        mediaType: 'application/octet-stream',
                    },
                    discard: async () => {
                        discarded++;
                    },
                };
            },
            videos:
                kind === 'm.video'
                    ? {
                          prepare: async () => {
                              prepared++;
                              if (revoke) joined = false;
                              return {
                                  request: {
                                      profile,
                                      chatId: chat,
                                      token: 'a'.repeat(64),
                                      fileName: 'converted.mp4',
                                      mediaType: 'video/mp4' as const,
                                      durationSeconds: 1,
                                      width: 64,
                                      height: 48,
                                  },
                                  projection: {
                                      kind: 'video' as const,
                                      fileName: 'converted.mp4',
                                      mediaType: 'video/mp4' as const,
                                      bytes: 3,
                                      durationSeconds: 1,
                                      width: 64,
                                      height: 48,
                                  },
                                  discard: async () => {
                                      discarded++;
                                  },
                              };
                          },
                          send: async (_request, persist) => {
                              assert.equal(
                                  outbox.media.videoProjection(profile, '$file')?.kind,
                                  'video',
                                  'Projection is durable before invocation',
                              );
                              const ids = ['m:0200000000000000'];
                              await persist(ids);
                              assert.deepEqual(outbox.media.get(profile, '$file')!.ids, ids);
                              sent++;
                              return ids;
                          },
                      }
                    : undefined,
            backend: {
                sendPreparedFile: async (_request, persist) => {
                    const ids = ['m:0200000000000000'];
                    await persist(ids);
                    assert.deepEqual(outbox.media.get(profile, '$file')!.ids, ids);
                    sent++;
                    return ids;
                },
            },
        });
        try {
            portals.bind(profile, chat, room);
            const base = {room_id: room, sender: owner, type: 'm.room.message', encrypted: true};
            inbox.accept('transaction', {});
            inbox.complete('transaction', [
                {...base, event_id: '$text', content: {msgtype: 'm.text', body: 'first'}},
                {
                    ...base,
                    event_id: '$file',
                    content: {
                        msgtype: kind,
                        body: 'fixture.bin',
                        info: {
                            size: 3,
                            mimetype: kind === 'm.video' ? 'video/mp4' : 'application/octet-stream',
                        },
                        file: {
                            url: 'mxc://invalid/id',
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
                },
            ]);
            await assert.rejects(runtime.drain());
            assert.equal(prepared, 0);
            const textId = createRequestId();
            outbox.prepare({
                requestId: textId,
                profile,
                sender: owner,
                roomId: room,
                chatId: chat,
                eventId: '$text',
                transactionId: 'transaction',
                text: 'first',
            });
            await assert.rejects(runtime.drain());
            assert.equal(outbox.media.get(profile, '$file')!.state, 'PREPARED');
            assert.equal(prepared, 0, 'classified but unsettled text still blocks download');
            outbox.claim(textId);
            outbox.recordIds(textId, ['m:0100000000000000']);
            outbox.sent(textId, ['m:0100000000000000']);
            outbox.retryPrepared(profile);
            await assert.rejects(runtime.drain());
            assert.equal(discarded, 1);
            assert.equal(sent, 0);
            assert.equal(outbox.media.get(profile, '$file')!.state, 'PREPARED');
            joined = true;
            revoke = false;
            ready = false;
            assert.equal(await runtime.drain(), 0);
            ready = true;
            outbox.retryPrepared(profile);
            assert.equal(await runtime.drain(), 1);
            assert.equal(sent, 1);
            assert.equal(outbox.media.get(profile, '$file')!.state, 'SENT');
        } finally {
            inbox.close();
            outbox.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
