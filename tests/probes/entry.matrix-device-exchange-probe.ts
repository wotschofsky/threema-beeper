import {EncryptedSender} from '../../src/matrix/encrypted-sender.ts';
import {ManagementWorker} from '../../src/management/worker.ts';
import {managementRoomState, assertManagementRoomState} from '../../src/management/room-policy.ts';
import {PortalStore} from '../../src/matrix/portal-store.ts';
import {TransactionInbox} from '../../src/matrix/transaction-inbox.ts';
import {TransactionWorker} from '../../src/matrix/transaction-worker.ts';
import type {NativeTransaction} from '../../src/matrix/native-transaction.ts';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
    EncryptedRoomEvent,
    LogLevel,
    LogService,
    MatrixClient,
    MemoryStorageProvider,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProtectedCryptoStorage} from '../../src/matrix/protected-storage.ts';
import {processNativeTransaction} from '../../src/matrix/native-transaction.ts';

// The transport below models only the Matrix endpoints used by this test. All device keys,
// signatures, Olm sessions, Megolm sessions and ciphertext are produced by the pinned SDK.
interface Device {
    user: string;
    id: string;
    keys?: unknown;
    oneTime: Record<string, unknown>;
    toDevice: any[];
}
assert.equal(process.versions.node.split('.')[0], '24');
LogService.setLevel(LogLevel.ERROR);

await test(
    'two native SDK devices exchange real encrypted session keys and reopen without losing decryption',
    {timeout: 30000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-device-exchange-'));
        const masterKeys = [randomBytes(32), randomBytes(32)];
        const portalKey = randomBytes(32);
        let portals = new PortalStore(join(directory, 'portals.sqlite'), portalKey);
        const sentTransactions = new Map<string, any>();
        let loseSendReply = true;
        const inbox = new TransactionInbox(join(directory, 'transactions.sqlite'), randomBytes(32));
        const devices: Device[] = ['alice', 'bob'].map((name) => ({
            user: `@${name}:example.invalid`,
            id: name.toUpperCase(),
            oneTime: {},
            toDevice: [],
        }));
        const room = '!synthetic:example.invalid';
        const joined = new Set(devices.map((device) => device.user));
        let membershipOutage = false;
        const clients: MatrixClient[] = [];
        const stores: ProtectedCryptoStorage[] = [];
        const events: any[] = [];
        let keyClaims = 0;
        let encryptedKeyMessages = 0;
        function open(index: number): MatrixClient {
            const device = devices[index]!;
            const store = new ProtectedCryptoStorage(
                join(directory, device.id),
                masterKeys[index]!,
            );
            stores[index] = store;
            const client = new MatrixClient(
                'https://example.invalid',
                'synthetic',
                new MemoryStorageProvider(),
                store,
            );
            client.doRequest = async (
                _method: string,
                path: string,
                query?: any,
                payload?: any,
            ): Promise<any> => {
                if (path.endsWith('/account/whoami'))
                    return {user_id: device.user, device_id: device.id};
                if (path.endsWith('/keys/upload')) {
                    if (payload.device_keys) device.keys = payload.device_keys;
                    Object.assign(device.oneTime, payload.one_time_keys ?? {});
                    return {
                        one_time_key_counts: {
                            signed_curve25519: Object.keys(device.oneTime).length,
                        },
                    };
                }
                if (path.endsWith('/keys/query')) {
                    const result: Record<string, unknown> = {};
                    for (const user of Object.keys(payload.device_keys)) {
                        const match = devices.find((candidate) => candidate.user === user);
                        result[user] = match?.keys ? {[match.id]: match.keys} : {};
                    }
                    return {device_keys: result, failures: {}};
                }
                if (path.endsWith('/keys/claim')) {
                    const result: Record<string, unknown> = {};
                    for (const [user, requested] of Object.entries(
                        payload.one_time_keys as Record<string, Record<string, string>>,
                    )) {
                        const match = devices.find((candidate) => candidate.user === user);
                        assert.ok(match);
                        const perDevice: Record<string, unknown> = {};
                        for (const [id, algorithm] of Object.entries(requested)) {
                            assert.equal(id, match.id);
                            const keyId = Object.keys(match.oneTime).find((key) =>
                                key.startsWith(`${algorithm}:`),
                            );
                            assert.ok(keyId, 'Real uploaded one-time key must be available');
                            perDevice[id] = {[keyId]: match.oneTime[keyId]};
                            delete match.oneTime[keyId];
                            keyClaims++;
                        }
                        result[user] = perDevice;
                    }
                    return {one_time_keys: result, failures: {}};
                }
                if (path.includes('/sendToDevice/')) {
                    const type = decodeURIComponent(
                        path.split('/sendToDevice/')[1]!.split('/')[0]!,
                    );
                    assert.equal(type, 'm.room.encrypted');
                    for (const [user, messages] of Object.entries(
                        payload.messages as Record<string, Record<string, unknown>>,
                    )) {
                        const match = devices.find((candidate) => candidate.user === user);
                        assert.ok(match);
                        for (const [id, content] of Object.entries(messages)) {
                            assert.equal(id, match.id);
                            match.toDevice.push({
                                sender: device.user,
                                type,
                                content,
                                to_user_id: user,
                                to_device_id: id,
                            });
                            encryptedKeyMessages++;
                        }
                    }
                    return {};
                }
                if (path.endsWith('/members')) {
                    if (membershipOutage) throw new Error('synthetic membership outage');
                    return {
                        chunk:
                            query?.membership === 'invite'
                                ? []
                                : devices
                                      .filter((member) => joined.has(member.user))
                                      .map((member) => ({
                                          type: 'm.room.member',
                                          state_key: member.user,
                                          sender: member.user,
                                          content: {membership: 'join'},
                                      })),
                    };
                }
                if (path.includes('/state/m.room.encryption'))
                    return {algorithm: 'm.megolm.v1.aes-sha2'};
                if (path.includes('/send/')) {
                    const previous = sentTransactions.get(device.user + path);
                    if (previous) {
                        assert.deepEqual(
                            payload,
                            previous.content,
                            'Retry must preserve native ciphertext',
                        );
                        return {event_id: previous.event_id};
                    }
                    assert.ok(
                        path.includes('/send/m.room.encrypted/'),
                        'Plaintext room sends are forbidden',
                    );
                    const event = {
                        type: 'm.room.encrypted',
                        event_id: `$synthetic${events.length}`,
                        room_id: room,
                        sender: device.user,
                        origin_server_ts: events.length + 1,
                        content: payload,
                    };
                    events.push(event);
                    sentTransactions.set(device.user + path, event);
                    if (loseSendReply) {
                        loseSendReply = false;
                        throw new Error('synthetic lost encrypted reply');
                    }
                    return {event_id: event.event_id};
                }
                throw new Error(`Unexpected mock endpoint: ${path}`);
            };
            clients[index] = client;
            return client;
        }
        async function receive(index: number): Promise<void> {
            const device = devices[index]!;
            const pending = device.toDevice.splice(0);
            assert.ok(
                pending.length > 0,
                'Recipient must receive an actual encrypted Olm key message',
            );
            await assert.rejects(
                processNativeTransaction(
                    {
                        'events': [],
                        'de.sorunome.msc2409.to_device': pending.map((event) => ({
                            ...event,
                            to_device_id: 'UNEXPECTED',
                        })),
                    },
                    new Map([[device.user, clients[index]!]]),
                    () => clients[index]!,
                    async () => {
                        assert.fail('An invalid recipient must not reach event delivery');
                    },
                ),
                /Unexpected recipient device/,
            );
            const transaction: NativeTransaction = {
                'events': [events.at(-1)],
                'de.sorunome.msc2409.to_device': pending,
                'org.matrix.msc3202.device_one_time_keys_count': {
                    [device.user]: {
                        [device.id]: {signed_curve25519: Object.keys(device.oneTime).length},
                    },
                },
                'org.matrix.msc3202.device_lists': {
                    changed: devices.map((d) => d.user),
                    removed: [],
                },
            };
            const transactionId = 'incoming-' + index;
            inbox.accept(transactionId, transaction);
            const worker = new TransactionWorker(inbox, async (body, emit) => {
                await processNativeTransaction(
                    body as NativeTransaction,
                    new Map([[device.user, clients[index]!]]),
                    () => clients[index]!,
                    emit,
                );
            });
            assert.equal(await worker.drain(), 1);
            assert.ok(
                inbox
                    .pendingEvents()
                    .some(
                        (event) =>
                            event.event_id === events.at(-1).event_id &&
                            event.type === 'm.room.message',
                    ),
            );
            assert.equal(inbox.accept(transactionId, transaction), 'duplicate');
            assert.equal(await worker.drain(), 0);
        }
        try {
            for (let index = 0; index < devices.length; index++) {
                const client = open(index);
                await stores[index]!.storeRoom(room, {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    historyVisibility: 'joined',
                });
                await client.crypto.prepare();
            }
            function sender(index: number): EncryptedSender {
                return new EncryptedSender(
                    {
                        userId: devices[index]!.user,
                        underlyingClient: clients[index]!,
                        enableEncryption: async () => {
                            await clients[index]!.crypto.prepare();
                        },
                    },
                    portals,
                );
            }
            const aliceContent = {msgtype: 'm.text', body: 'synthetic alice to bob'};
            await assert.rejects(
                sender(0).send('alice-1', room, 'm.room.message', aliceContent),
                /lost encrypted reply/,
            );
            portals.close();
            portals = new PortalStore(join(directory, 'portals.sqlite'), portalKey);
            assert.equal(
                await sender(0).send('alice-1', room, 'm.room.message', aliceContent),
                '$synthetic0',
            );
            assert.equal(events.length, 1);
            await assert.rejects(
                clients[1]!.crypto.decryptRoomEvent(new EncryptedRoomEvent(events[0]), room),
            );
            await receive(1);
            const first = await clients[1]!.crypto.decryptRoomEvent(
                new EncryptedRoomEvent(events[0]),
                room,
            );
            assert.deepEqual(first.content, {msgtype: 'm.text', body: 'synthetic alice to bob'});
            await sender(1).send('bob-1', room, 'm.room.message', {
                msgtype: 'm.text',
                body: 'synthetic bob to alice',
            });
            await receive(0);
            const second = await clients[0]!.crypto.decryptRoomEvent(
                new EncryptedRoomEvent(events[1]),
                room,
            );
            assert.deepEqual(second.content, {msgtype: 'm.text', body: 'synthetic bob to alice'});
            await assert.rejects(
                processNativeTransaction(
                    {events: [events[0]]},
                    new Map([[devices[1]!.user, clients[1]!]]),
                    () => clients[1]!,
                    async () => {
                        throw new Error('synthetic durable inbox failure');
                    },
                ),
                /synthetic durable inbox failure/,
            );
            const identities = clients.map((client) => client.crypto.clientDeviceEd25519);
            for (let index = 0; index < devices.length; index++) {
                clients[index]!.crypto.close();
                stores[index]!.close();
                await open(index).crypto.prepare();
                assert.equal(clients[index]!.crypto.clientDeviceEd25519, identities[index]);
            }
            assert.deepEqual(
                (await clients[1]!.crypto.decryptRoomEvent(new EncryptedRoomEvent(events[0]), room))
                    .content,
                first.content,
            );
            assert.deepEqual(
                (await clients[0]!.crypto.decryptRoomEvent(new EncryptedRoomEvent(events[1]), room))
                    .content,
                second.content,
            );
            membershipOutage = true;
            const eventCount = events.length;
            await assert.rejects(
                sender(0).send('membership-outage', room, 'm.room.message', {
                    msgtype: 'm.text',
                    body: 'must remain pending',
                }),
                /establish encryption recipients/,
            );
            assert.equal(events.length, eventCount);
            assert.equal(portals.operation('membership-outage'), undefined);
            membershipOutage = false;
            const previousSession = events[0].content.session_id;
            joined.delete(devices[1]!.user);
            await sender(0).send('after-removal', room, 'm.room.message', {
                msgtype: 'm.text',
                body: 'only remaining members',
            });
            assert.notEqual(
                events.at(-1).content.session_id,
                previousSession,
                'Removing a recipient must rotate the outbound session',
            );
            await assert.rejects(
                clients[1]!.crypto.decryptRoomEvent(new EncryptedRoomEvent(events.at(-1)), room),
            );
            const removedEvent = events.at(-1);
            devices[1]!.toDevice.length = 0;
            joined.add(devices[1]!.user);
            await sender(0).send('after-rejoin', room, 'm.room.message', {
                msgtype: 'm.text',
                body: 'welcome back',
            });
            const rejoinKeys = devices[1]!.toDevice.splice(0);
            assert.ok(rejoinKeys.length > 0, 'Rejoining recipient needs a session key');
            await processNativeTransaction(
                {'events': [events.at(-1)], 'de.sorunome.msc2409.to_device': rejoinKeys},
                new Map([[devices[1]!.user, clients[1]!]]),
                () => clients[1]!,
                async (event) => {
                    assert.equal(event.content.body, 'welcome back');
                },
            );
            await assert.rejects(
                clients[1]!.crypto.decryptRoomEvent(new EncryptedRoomEvent(removedEvent), room),
                'Rejoining must not reveal messages sent while absent',
            );
            await sender(0).send('native-reaction', room, 'm.reaction', {
                'm.relates_to': {rel_type: 'm.annotation', event_id: '$synthetic0', key: '👍'},
            });
            const reaction = await clients[1]!.crypto.decryptRoomEvent(
                new EncryptedRoomEvent(events.at(-1)),
                room,
            );
            assert.equal(reaction.type, 'm.reaction');
            assert.deepEqual(reaction.content, {
                'm.relates_to': {rel_type: 'm.annotation', event_id: '$synthetic0', key: '👍'},
            });
            // Alice is the owner and Bob is the bridge in this synthetic management room.
            // Clear earlier probe inputs so they cannot be interpreted as new commands.
            for (const event of inbox.pendingEvents()) inbox.acknowledgeEvent(event.event_id);
            const managementIdentity = {
                profile: 'SELF1234',
                owner: devices[0]!.user,
                bot: devices[1]!.user,
            };
            const managementState: any[] = [
                ...managementRoomState(managementIdentity).map((event) => ({
                    ...event,
                    sender: devices[1]!.user,
                })),
                ...devices.map((device) => ({
                    type: 'm.room.member',
                    state_key: device.user,
                    content: {membership: 'join'},
                })),
            ];
            await sender(0).send('owner-command', room, 'm.room.message', {
                msgtype: 'm.text',
                body: 'status',
            });
            const commandEvent = events.at(-1);
            const commandTransaction: NativeTransaction = {
                'events': [commandEvent],
                'de.sorunome.msc2409.to_device': devices[1]!.toDevice.splice(0),
            };
            inbox.accept('owner-command-ingress', commandTransaction);
            const decoder = new TransactionWorker(inbox, async (body, emit) => {
                await processNativeTransaction(
                    body as NativeTransaction,
                    new Map([[devices[1]!.user, clients[1]!]]),
                    () => clients[1]!,
                    emit,
                );
            });
            assert.equal(await decoder.drain(), 1);
            const command = inbox.pendingEvents()[0]!;
            assert.equal(command.encrypted, true);
            assert.equal(command.sender, managementIdentity.owner);
            assert.equal(command.content.body, 'status');
            let executions = 0;
            const management = () =>
                new ManagementWorker({
                    inbox,
                    owner: managementIdentity.owner,
                    room,
                    ready: () => true,
                    authorize: async () =>
                        assertManagementRoomState(managementState, managementIdentity),
                    execute: async (_command, id) => {
                        assert.equal(id, commandEvent.event_id);
                        executions++;
                        return {msgtype: 'm.notice', body: 'Synthetic bridge ready.'};
                    },
                    send: (id, target, content) =>
                        sender(1).send(id, target, 'm.room.message', content),
                });
            managementState.push({
                type: 'm.room.member',
                state_key: '@outsider:example.invalid',
                content: {membership: 'invite'},
            });
            await assert.rejects(management().drain(), /authorization failed/);
            assert.equal(executions, 0);
            managementState.pop();
            loseSendReply = true;
            await assert.rejects(management().drain(), /lost encrypted reply/);
            assert.equal(executions, 1);
            assert.equal(inbox.pendingEvents().length, 1);
            const replyCount = events.length;
            assert.equal(await management().drain(), 1);
            assert.equal(executions, 1);
            assert.equal(
                events.length,
                replyCount,
                'Reply retry must reuse native ciphertext and Matrix transaction ID',
            );
            const replies: any[] = [];
            await processNativeTransaction(
                {
                    'events': [events.at(-1)],
                    'de.sorunome.msc2409.to_device': devices[0]!.toDevice.splice(0),
                },
                new Map([[devices[0]!.user, clients[0]!]]),
                () => clients[0]!,
                async (event) => {
                    replies.push(event);
                },
            );
            assert.equal(replies[0].encrypted, true);
            assert.equal(replies[0].sender, managementIdentity.bot);
            assert.equal(replies[0].content.body, 'Synthetic bridge ready.');
            assert.equal(
                replies[0].content['m.relates_to']['m.in_reply_to'].event_id,
                commandEvent.event_id,
            );
            assert.equal(inbox.pendingEvents().length, 0);
            assert(!JSON.stringify(events).includes('Synthetic bridge ready.'));
            assert.ok(keyClaims >= 1);
            assert.ok(encryptedKeyMessages >= 2);
            assert.ok(!JSON.stringify(events).includes('synthetic alice to bob'));
            assert.ok(!JSON.stringify(events).includes('synthetic bob to alice'));
        } finally {
            for (const client of clients) client.crypto.close();
            for (const store of stores) store.close();
            inbox.close();
            portals.close();
            portalKey.fill(0);
            for (const key of masterKeys) key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
