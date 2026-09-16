import {createOwnerMediaRenderer} from '../src/matrix/owner-media-content.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {MatrixJournalSink, type BridgeIntent} from '../src/matrix/journal-sink.ts';
import {JournalDelivery} from '../src/matrix/journal-delivery.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import {ghostUserId} from '../src/matrix/ghosts.ts';

await test('journal text reaches encrypted portal and survives lost response with durable metadata already acknowledged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-sink-'));
    const keys = [randomBytes(32), randomBytes(32), randomBytes(32)];
    let pictureReads = 0;
    const profilePicture = async () => {
        pictureReads++;
        throw new Error('synthetic picture unavailable');
    };
    let outbox = new OutboxStore(join(directory, 'outbox.sqlite'), keys[2]!);
    const profile = 'SELF1234',
        remote = 'TEST1234',
        owner = '@owner:matrix.invalid',
        botId = '@bot:matrix.invalid',
        domain = 'matrix.invalid',
        room = '!portal:matrix.invalid';
    let store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
    let journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
    const chat = {
        chatId: `c:${remote}`,
        name: 'Contact',
        unreadCount: 0,
        archived: false,
        pinned: false,
    };
    const message: NormalizedNodeMessage = {
        chatId: chat.chatId,
        messageId: 'm:0100000000000000',
        direction: 'inbound',
        senderIdentity: remote,
        createdAt: new Date(1234),
        ordinal: 1n,
        reactions: [],
        content: {type: 'text', text: 'A'},
    };
    const token = journal.beginReconciliation(chat.chatId);
    journal.stage(token, 'snapshot', message);
    journal.commitProfile([token], {
        directory: {
            contacts: [
                {
                    identity: remote,
                    firstName: 'Contact',
                    lastName: '',
                    displayName: 'Contact',
                    verification: 0,
                    activity: 0,
                    blocked: false,
                },
            ],
            groups: [],
        },
        chats: [chat],
    });
    const state: any[] = [];
    const profiles = new Map<string, string>();
    const intents = new Map<string, BridgeIntent>();
    const membership = new Map<string, string>();
    const enabled = new Set<string>();
    const sends = new Map<string, {event_id: string; body: unknown}>();
    let loseReply = true,
        creates = 0,
        encryptions = 0;
    const clear: Record<string, unknown>[] = [];
    const senders: string[] = [];
    const redactions = new Map<string, string>();
    const receiptTargets: string[] = [];
    let loseRedactionReply = true;
    function getIntent(userId: string): BridgeIntent {
        const cached = intents.get(userId);
        if (cached) return cached;
        const client = new MatrixClient('https://matrix.invalid', 'synthetic');
        Object.defineProperty(client, 'crypto', {
            value: {
                encryptRoomEvent: async (
                    _room: string,
                    _type: string,
                    body: Record<string, unknown>,
                ) => {
                    assert.ok(enabled.has(userId));
                    assert.equal(membership.get(userId), 'join');
                    encryptions++;
                    clear.push(body);
                    senders.push(userId);
                    return {
                        algorithm: 'm.megolm.v1.aes-sha2',
                        ciphertext: `synthetic-${encryptions}`,
                        session_id: 'SESSION',
                        sender_key: 'KEY',
                        device_id: 'DEVICE',
                    };
                },
            },
        });
        client.doRequest = async (method, path, _query, body): Promise<any> => {
            if (path.endsWith('/account/whoami')) return {user_id: userId, device_id: 'DEVICE'};
            if (path.includes('/profile/')) {
                if (method === 'GET') return {displayname: profiles.get(userId)};
                profiles.set(userId, body.displayname);
                return {};
            }
            if (path.includes('/directory/room/')) {
                if (!creates) throw {errcode: 'M_NOT_FOUND'};
                return {room_id: room};
            }
            if (path.endsWith('/createRoom')) {
                creates++;
                assert.ok(enabled.has(botId));
                assert.equal(body.visibility, 'private');
                assert.equal(body['com.beeper.auto_join_invites'], true);
                state.push(...body.initial_state.map((event: any) => ({...event, sender: botId})), {
                    type: 'm.room.name',
                    state_key: '',
                    content: {name: body.name},
                });
                membership.set(botId, 'join');
                membership.set(owner, 'invite');
                return {room_id: room};
            }
            if (path.endsWith('/state'))
                return [
                    ...state,
                    ...[...membership].map(([state_key, membership]) => ({
                        type: 'm.room.member',
                        state_key,
                        content: {membership},
                    })),
                ];
            if (path.includes('/state/m.room.encryption'))
                return {algorithm: 'm.megolm.v1.aes-sha2'};
            if (path.includes('/state/m.room.name')) {
                state.find((event) => event.type === 'm.room.name').content = body;
                return {event_id: '$name'};
            }
            if (method === 'PUT' && /\/state\/(?:m\.bridge|uk\.half-shot\.bridge)\//.test(path)) {
                const type = path.split('/state/')[1]!.split('/')[0]!;
                const existing = state.find((event) => event.type === type);
                if (existing) existing.content = body;
                else
                    state.push({type, state_key: 'threema://bridge', sender: botId, content: body});
                return {event_id: '$bridge-info'};
            }
            if (path.endsWith('/invite')) {
                membership.set(body.user_id, 'invite');
                return {};
            }
            if (path.includes('/receipt/m.read/')) {
                assert.equal(method, 'POST');
                receiptTargets.push(decodeURIComponent(path.split('/receipt/m.read/')[1]!));
                return {};
            }
            if (path.includes('/redact/')) {
                assert.equal(userId, botId);
                assert.equal(method, 'PUT');
                assert.deepEqual(body, {});
                const previous = redactions.get(path);
                if (previous) return {event_id: previous};
                const event = `$redaction${redactions.size}`;
                redactions.set(path, event);
                if (loseRedactionReply) {
                    loseRedactionReply = false;
                    throw new Error('synthetic lost redaction reply');
                }
                return {event_id: event};
            }
            if (path.includes('/send/')) {
                assert.ok(path.includes('/send/m.room.encrypted/'));
                const previous = sends.get(path);
                if (previous) {
                    assert.deepEqual(previous.body, body);
                    return previous;
                }
                const response = {event_id: `$message${sends.size}`, body};
                sends.set(path, response);
                if (loseReply) {
                    loseReply = false;
                    throw new Error('synthetic lost send reply');
                }
                return response;
            }
            throw new Error(`Unexpected test request: ${path}`);
        };
        const intent: BridgeIntent = {
            userId,
            underlyingClient: client,
            ensureRegistered: async () => {},
            enableEncryption: async () => {
                enabled.add(userId);
            },
            joinRoom: async () => {
                assert.equal(membership.get(userId), 'invite');
                membership.set(userId, 'join');
                return room;
            },
            leaveRoom: async () => {
                membership.set(userId, 'leave');
            },
        };
        intents.set(userId, intent);
        return intent;
    }
    let textOnly = false;
    let mediaEnabled = false;
    let ownerEnabled = false;
    let revokeOwner = false;
    const make = () =>
        new JournalDelivery(
            journal,
            new MatrixJournalSink({
                textOnly,
                profile,
                owner,
                domain,
                outbox,
                store,
                bot: getIntent(botId),
                getIntent,
                getOwnerIntent: ownerEnabled
                    ? async () => {
                          if (revokeOwner) membership.set(owner, 'leave');
                          return getIntent(owner);
                      }
                    : undefined,
                metadata: () => journal.metadata(),
                profilePicture,
                renderOwnerMedia: mediaEnabled
                    ? createOwnerMediaRenderer({
                          profile,
                          owner,
                          portals: store,
                          original: async (event, target) => {
                              assert.equal(event, '$owner-file');
                              assert.equal(target, room);
                              const original = outbox.media.get(profile, event)!.request.media;
                              return {
                                  event_id: event,
                                  room_id: room,
                                  sender: owner,
                                  type: 'm.room.message',
                                  encrypted: true,
                                  content: {
                                      msgtype: original.kind,
                                      filename: original.filename,
                                      body: original.filename,
                                      file: original.file,
                                      info: {size: original.bytes, mimetype: original.mimeType},
                                  },
                              };
                          },
                      })
                    : undefined,
                renderMedia: mediaEnabled
                    ? async () => {
                          throw new Error('Owner file echo must not download or upload media');
                      }
                    : undefined,
            }),
            () => true,
        );
    let delivery = make();
    try {
        // Contact-only metadata must not create rooms or invitations. A real message
        // below is the trigger for the first portal, even without a lastMessageId hint.
        const metadataSink = new MatrixJournalSink({
            profile,
            owner,
            domain,
            store,
            bot: getIntent(botId),
            getIntent,
            metadata: () => journal.metadata(),
            profilePicture,
        });
        await metadataSink.metadata(journal.metadata()!, 'contacts-only');
        assert.equal(pictureReads, 0, 'Contact-only metadata does not fetch pictures');
        assert.equal(creates, 0);

        await assert.rejects(delivery.flush(), /lost send reply/);
        assert.equal(journal.metadata(true), undefined);
        assert.equal(journal.pending().length, 1);
        assert.equal(sends.size, 1);
        assert.ok(pictureReads > 0, 'Text delivery proceeds even when the contact picture fails');
        assert.equal(creates, 1);
        assert.equal(profiles.get(ghostUserId(profile, remote, domain)), 'Contact');
        await delivery.stop();
        store.close();
        journal.close();
        store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
        journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
        delivery = make();
        assert.equal(await delivery.flush(), 1);
        assert.equal(journal.pending().length, 0);
        assert.equal(encryptions, 1);
        assert.equal(
            store.messageMapping(profile, chat.chatId, message.messageId)?.root,
            '$message0',
        );
        journal.upsert({...message, content: {type: 'text', text: 'B'}});
        assert.equal(await delivery.flush(), 1);
        assert.equal(sends.size, 2);
        assert.deepEqual(clear[1]!['m.relates_to'], {rel_type: 'm.replace', event_id: '$message0'});
        const reacted: NormalizedNodeMessage = {
            ...message,
            content: {type: 'text', text: 'B'},
            reactions: [{senderIdentity: profile, emoji: '👍', reactedAt: new Date(3000)}],
        };
        loseReply = true;
        journal.upsert(reacted);
        await assert.rejects(delivery.flush(), /lost send reply/);
        assert.equal(journal.pending().length, 1);
        assert.equal(sends.size, 3);
        assert.equal(store.reactions(profile, chat.chatId, message.messageId).length, 0);
        assert.equal(await delivery.flush(), 1);
        assert.equal(sends.size, 3);
        assert.deepEqual(clear[2]!['m.relates_to'], {
            rel_type: 'm.annotation',
            event_id: '$message0',
            key: '👍',
        });
        const originalReaction = store.reactions(profile, chat.chatId, message.messageId)[0]!.event;
        journal.upsert({...reacted, reactions: []});
        await assert.rejects(delivery.flush(), /lost redaction reply/);
        assert.equal(store.reactions(profile, chat.chatId, message.messageId).length, 1);
        await delivery.stop();
        store.close();
        journal.close();
        store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
        journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
        delivery = make();
        assert.equal(await delivery.flush(), 1);
        assert.equal(redactions.size, 1);
        assert.equal(store.reactions(profile, chat.chatId, message.messageId).length, 0);
        journal.upsert(reacted);
        assert.equal(await delivery.flush(), 1);
        assert.equal(sends.size, 4);
        assert.notEqual(
            store.reactions(profile, chat.chatId, message.messageId)[0]!.event,
            originalReaction,
        );
        journal.upsert({...reacted, content: {type: 'text', text: 'C'}});
        assert.equal(await delivery.flush(), 1);
        assert.equal(sends.size, 5);
        loseRedactionReply = true;
        journal.upsert({...message, content: {type: 'deleted'}, deletedAt: new Date(5000)});
        await assert.rejects(delivery.flush(), /lost redaction reply/);
        assert.equal(store.deletion(profile, chat.chatId, message.messageId)?.done, 0);
        await delivery.stop();
        store.close();
        journal.close();
        store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
        journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
        delivery = make();
        assert.equal(await delivery.flush(), 1);
        assert.equal(store.deletion(profile, chat.chatId, message.messageId)?.done, 1);
        assert.equal(store.reactions(profile, chat.chatId, message.messageId).length, 0);
        const targets = new Set(
            [...redactions.keys()].map((path) =>
                decodeURIComponent(path.split('/redact/')[1]!.split('/')[0]!),
            ),
        );
        assert.deepEqual(
            targets,
            new Set(['$message0', '$message1', '$message2', '$message3', '$message4']),
        );
        assert.equal(redactions.size, 5);
        journal.upsert(reacted);
        assert.equal(
            await delivery.flush(),
            1,
            'Stale snapshots are consumed without resurrection',
        );
        assert.equal(sends.size, 5);
        const neverSent = {
            ...message,
            messageId: 'm:0200000000000000',
            ordinal: 2n,
            content: {type: 'deleted' as const},
        };
        journal.upsert(neverSent);
        assert.equal(await delivery.flush(), 1);
        assert.equal(store.deletion(profile, chat.chatId, neverSent.messageId)?.done, 1);
        assert.equal(sends.size, 5);
        const readMessage: NormalizedNodeMessage = {
            ...message,
            messageId: 'm:0300000000000000',
            ordinal: 3n,
            readAt: new Date(6000),
        };
        journal.upsert(readMessage);
        assert.equal(await delivery.flush(), 1);
        assert.equal(clear.at(-1)!.status, 'read');
        assert.deepEqual(receiptTargets, [
            store.messageMapping(profile, chat.chatId, readMessage.messageId)!.root,
        ]);
        const requestId = createRequestId();
        const echo: NormalizedNodeMessage = {
            ...message,
            direction: 'outbound',
            senderIdentity: profile,
            messageId: 'm:ffffffffffffffff',
            ordinal: 5n,
            content: {type: 'text', text: 'sent from Beeper'},
        };
        outbox.prepare({
            requestId,
            profile,
            transactionId: 'owner-txn',
            eventId: '$owner-original',
            roomId: room,
            sender: owner,
            chatId: chat.chatId,
            text: 'sent from Beeper',
        });
        outbox.claim();
        outbox.recordIds(requestId, [echo.messageId]);
        const beforeEcho = sends.size;
        journal.upsert(echo);
        assert.equal(await delivery.flush(), 1);
        assert.equal(sends.size, beforeEcho, 'Owner echo must not create a second Matrix message');
        assert.equal(
            outbox.get(requestId)!.state,
            'DISPATCHING',
            'Local insertion is not transport evidence',
        );
        assert.equal(
            store.messageMapping(profile, chat.chatId, echo.messageId)!.root,
            '$owner-original',
        );
        assert.equal(store.messageMapping(profile, chat.chatId, echo.messageId)!.sender, owner);
        assert.equal(
            store.messageForEvent(profile, chat.chatId, '$owner-original'),
            echo.messageId,
        );
        outbox.sent(requestId, [echo.messageId]);
        journal.upsert({...echo, deliveredAt: new Date(8000)});
        assert.equal(await delivery.flush(), 1);
        assert.equal(clear.at(-1)!.status, 'delivered');
        assert.equal(
            (clear.at(-1)!['m.relates_to'] as {event_id: string}).event_id,
            '$owner-original',
        );
        await delivery.stop();
        const legacyPhone: NormalizedNodeMessage = {
            ...echo,
            messageId: 'm:0600000000000000',
            ordinal: 7n,
            content: {type: 'text', text: 'phone message before owner support'},
        };
        delivery = make();
        loseReply = true;
        journal.upsert(legacyPhone);
        await assert.rejects(delivery.flush(), /lost send reply/);
        const legacySender = ghostUserId(profile, profile, domain);
        assert.equal(senders.at(-1), legacySender);
        await delivery.stop();
        ownerEnabled = true;
        membership.set(owner, 'join');
        delivery = make();
        assert.equal(
            await delivery.flush(),
            1,
            'Pending legacy projection finishes under its original sender',
        );
        assert.equal(
            store.messageMapping(profile, chat.chatId, legacyPhone.messageId)!.sender,
            legacySender,
        );
        journal.upsert({...legacyPhone, content: {type: 'text', text: 'legacy phone edit'}});
        assert.equal(await delivery.flush(), 1);
        assert.equal(senders.at(-1), legacySender);
        const freshPhone: NormalizedNodeMessage = {
            ...echo,
            messageId: 'm:0700000000000000',
            ordinal: 8n,
            content: {type: 'text', text: 'new phone message'},
        };
        journal.upsert(freshPhone);
        assert.equal(await delivery.flush(), 1);
        assert.equal(senders.at(-1), owner);
        const freshRoot = store.messageMapping(profile, chat.chatId, freshPhone.messageId)!.root;
        assert.equal('m.new_content' in clear.at(-1)!, false);
        journal.upsert({...freshPhone, content: {type: 'text', text: 'new phone edit'}});
        assert.equal(await delivery.flush(), 1);
        assert.equal(senders.at(-1), owner);
        assert.deepEqual(clear.at(-1)!['m.relates_to'], {
            rel_type: 'm.replace',
            event_id: freshRoot,
        });
        const beforePhone = sends.size;
        loseReply = true;
        journal.upsert({...echo, content: {type: 'text', text: 'changed on phone'}});
        revokeOwner = true;
        await assert.rejects(delivery.flush(), /authorization failed/);
        assert.equal(
            sends.size,
            beforePhone,
            'Revocation during owner initialization prevents sending',
        );
        revokeOwner = false;
        membership.set(owner, 'join');

        await assert.rejects(delivery.flush(), /lost send reply/);
        assert.equal(senders.at(-1), owner);
        assert.equal(journal.pending().length, 1);
        const encryptedBeforeRetry = encryptions;
        await delivery.stop();
        store.close();
        journal.close();
        store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
        journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
        delivery = make();
        assert.equal(await delivery.flush(), 1);
        assert.equal(
            encryptions,
            encryptedBeforeRetry,
            'Retry uses the persisted owner ciphertext',
        );
        assert.equal(sends.size, beforePhone + 1);
        assert.deepEqual(clear.at(-1)!['m.relates_to'], {
            rel_type: 'm.replace',
            event_id: '$owner-original',
        });
        assert.equal((clear.at(-1)!['m.new_content'] as {body: string}).body, 'changed on phone');
        assert.equal(store.messageMapping(profile, chat.chatId, echo.messageId)!.sender, owner);
        journal.upsert(echo);
        assert.equal(await delivery.flush(), 1);
        assert.equal(senders.at(-1), owner);
        assert.equal((clear.at(-1)!['m.new_content'] as {body: string}).body, 'sent from Beeper');
        // Crash after the owner mapping commits, before outbox observation commits.
        await delivery.stop();
        mediaEnabled = true;
        delivery = make();
        const mediaId = createRequestId();
        const fileEcho: NormalizedNodeMessage = {
            ...echo,
            messageId: 'm:0500000000000000',
            sentAt: new Date(7000),
            ordinal: 6n,
            content: {
                type: 'file',
                fileName: 'private.bin',
                mimeType: 'application/octet-stream',
                byteSize: 3,
            },
        };
        outbox.media.prepare({
            id: mediaId,
            profile,
            owner,
            event: '$owner-file',
            room,
            transaction: 'file-txn',
            media: {
                chat: chat.chatId,
                kind: 'm.file',
                filename: 'private.bin',
                mimeType: 'application/octet-stream',
                bytes: 3,
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
        });
        assert.equal(outbox.media.claim(profile, '$owner-file'), true);
        outbox.media.recordIds(profile, '$owner-file', [fileEcho.messageId]);
        const beforeFile = sends.size;
        outbox.media.observe = () => {
            throw new Error('synthetic media observation interruption');
        };
        journal.upsert(fileEcho);
        await assert.rejects(delivery.flush(), /observation interruption/);
        assert.equal(
            store.messageForEvent(profile, chat.chatId, '$owner-file'),
            fileEcho.messageId,
        );
        assert.equal(journal.pending().length, 1);
        await delivery.stop();
        outbox.close();
        store.close();
        journal.close();
        outbox = new OutboxStore(join(directory, 'outbox.sqlite'), keys[2]!);
        store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
        journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
        outbox.recoverInterrupted();
        assert.equal(outbox.media.get(profile, '$owner-file')!.state, 'OUTCOME_UNKNOWN');
        delivery = make();
        const acknowledge = journal.acknowledge.bind(journal);
        journal.acknowledge = () => {
            throw new Error('synthetic journal acknowledgement interruption');
        };
        await assert.rejects(delivery.flush(), /acknowledgement interruption/);
        assert.equal(outbox.media.get(profile, '$owner-file')!.state, 'SENT');
        journal.acknowledge = acknowledge;
        assert.equal(await delivery.flush(), 1);
        assert.equal(journal.pending().length, 0);
        assert.equal(
            sends.size,
            beforeFile + 1,
            'Restart adds only the confirmed sent-status event, not another file event',
        );
        assert.equal(clear.at(-1)!.status, 'sent');
        assert.equal(outbox.media.pendingCounts(profile).uncertain, 0);
        assert.equal(outbox.media.pendingCounts(profile).awaitingEcho, 0);
        assert.equal(
            store.messageMapping(profile, chat.chatId, fileEcho.messageId)!.root,
            '$owner-file',
        );
        assert.equal(
            outbox.media.next(profile),
            undefined,
            'Observed file must not become sendable again',
        );
        if (fileEcho.content.type !== 'file') assert.fail('Expected file fixture');
        outbox.mutations.prepare({
            profile,
            owner,
            room,
            chat: chat.chatId,
            event: '$earlier-file-caption',
            target: '$owner-file',
            commands: [
                {
                    profile,
                    chatId: chat.chatId,
                    messageId: fileEcho.messageId,
                    action: 'edit',
                    text: 'earlier Beeper caption',
                },
            ],
        });
        assert(outbox.mutations.claim(profile, '$earlier-file-caption', 0));
        outbox.mutations.finish(profile, '$earlier-file-caption', 0, 'APPLIED');

        journal.upsert({
            ...fileEcho,
            content: {...fileEcho.content, caption: 'phone file caption'},
        });
        assert.equal(await delivery.flush(), 1);
        assert.equal(senders.at(-1), owner);
        const captionContent = clear.at(-1)!['m.new_content'] as Record<string, unknown>;
        assert.equal(captionContent.body, 'phone file caption');
        assert.deepEqual(
            captionContent.file,
            outbox.media.get(profile, '$owner-file')!.request.media.file,
        );
        assert.deepEqual(clear.at(-1)!['m.relates_to'], {
            rel_type: 'm.replace',
            event_id: '$owner-file',
        });
        journal.upsert({
            ...fileEcho,
            content: {...fileEcho.content, caption: 'earlier Beeper caption'},
        });
        assert.equal(await delivery.flush(), 1);
        assert.equal(
            (clear.at(-1)!['m.new_content'] as {body: string}).body,
            'earlier Beeper caption',
        );
        journal.upsert(fileEcho);
        assert.equal(await delivery.flush(), 1);
        assert.equal((clear.at(-1)!['m.new_content'] as {body: string}).body, 'private.bin');
        await delivery.stop();
        mediaEnabled = false;
        delivery = make();
        journal.upsert({
            ...reacted,
            messageId: 'm:0400000000000000',
            ordinal: 4n,
            content: {type: 'file', mimeType: 'application/octet-stream', byteSize: 10},
        });
        await assert.rejects(delivery.flush(), /unimplemented delivery handler/);
        assert.equal(journal.pending().length, 1);
        await delivery.stop();
        textOnly = true;
        delivery = make();
        const beforeReduced = clear.length;
        const reducedMessage: NormalizedNodeMessage = {
            ...message,
            messageId: 'm:2000000000000000',
            ordinal: 20n,
            content: {type: 'text', text: 'Reduced direct text'},
        };
        journal.upsert({...reducedMessage, chatId: 'g:SELF1234:0100000000000000'});
        journal.upsert(reducedMessage);
        assert.equal(
            await delivery.flush(),
            3,
            'skipped media/group rows do not block the next text',
        );
        assert.equal(journal.pending().length, 0);
        assert.equal(clear.length, beforeReduced + 1);
        assert.equal(clear.at(-1)!.body, 'Reduced direct text');
        journal.upsert({...reducedMessage, content: {type: 'text', text: 'Deferred edit'}});
        assert.equal(await delivery.flush(), 1);
        assert.equal(clear.length, beforeReduced + 1, 'text-only roots remain unchanged');
        await delivery.stop();
        journal.close();
        store.close();
        store = new PortalStore(join(directory, 'portals.sqlite'), keys[0]!);
        journal = new MessageJournal(join(directory, 'journal.sqlite'), keys[1]!, profile);
        delivery = make();
        assert.equal(await delivery.flush(), 0);
        assert.equal(
            clear.length,
            beforeReduced + 1,
            'restart does not replay skipped or delivered rows',
        );
    } finally {
        await delivery.stop();
        store.close();
        journal.close();
        outbox.close();
        keys.forEach((key) => key.fill(0));
        rmSync(directory, {recursive: true, force: true});
    }
});
