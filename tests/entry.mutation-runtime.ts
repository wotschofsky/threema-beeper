import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {createMutationRuntime} from '../src/outbox/mutation-runtime.ts';
import {BackendWorkerError} from '../src/threema/backend-controller.ts';
import {UnsupportedNoticeWorker} from '../src/outbox/unsupported-notices.ts';
for (const lostResponse of [false, true])
    await test(`mutation runtime orders changes and recovers lost response=${lostResponse}`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'reaction-runtime-'));
        const key = randomBytes(32);
        const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
        const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
        const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
        const profile = 'SELF1234',
            owner = '@owner:invalid',
            room = '!room:invalid',
            chat = 'c:ABCD1234';
        const bot = {
            userId: '@bot:invalid',
            underlyingClient: {
                getRoomState: async (): Promise<any[]> => [
                    {
                        type: 'm.room.encryption',
                        state_key: '',
                        content: {algorithm: 'm.megolm.v1.aes-sha2'},
                    },
                    {
                        type: 'm.bridge',
                        state_key: 'threema://bridge',
                        sender: '@bot:invalid',
                        content: {creator: owner, network: {id: profile}, channel: {id: chat}},
                    },
                    {type: 'm.room.member', state_key: owner, content: {membership: 'join'}},
                ],
            },
        };
        try {
            portals.bind(profile, chat, room);
            const id = createRequestId();
            outbox.prepare({
                requestId: id,
                profile,
                sender: owner,
                roomId: room,
                chatId: chat,
                eventId: '$text',
                transactionId: 'text',
                text: 'Hello',
            });
            outbox.claim(id);
            outbox.recordIds(id, ['m:0100000000000000']);
            outbox.sent(id, ['m:0100000000000000']);
            const options = {profile, owner, portals, outbox, inbox, bot, ready: () => true};
            const calls: string[] = [];
            const failures: string[] = [];
            let authorized = true,
                observed = false,
                queries = 0;
            const getState = bot.underlyingClient.getRoomState;
            bot.underlyingClient.getRoomState = async () => {
                const state = await getState();
                if (!authorized) state[2].content.membership = 'leave';
                return state;
            };
            const runtime = createMutationRuntime({
                ...options,
                original: async () => ({
                    event_id: '$text',
                    room_id: room,
                    sender: owner,
                    encrypted: true,
                    type: 'm.room.message',
                    content: {msgtype: 'm.text', body: 'Hello'},
                }),
                backend: {
                    mutationState: async (request) => {
                        if (request.action === 'delete') return false;
                        queries++;
                        assert.equal(request.action, 'edit');
                        return observed;
                    },
                    mutateMessage: async (request) => {
                        calls.push(request.action);
                        if (request.action === 'delete')
                            throw new BackendWorkerError('delete-window-expired');
                        assert.equal(request.text, 'Edited');
                        if (lostResponse)
                            throw new Error('Synthetic lost response after native apply');
                    },
                },
                send: async (_id, target, content) => {
                    assert.equal(target, room);
                    failures.push(String(content.body));
                },
            });
            const notices = new UnsupportedNoticeWorker({
                ...options,
                mutationsEnabled: true,
                authorize: async () => {},
                send: async () => {
                    assert.fail('Mutation was classified as unsupported');
                },
            });
            inbox.accept('blocker', {});
            inbox.complete('blocker', [
                {
                    event_id: '$blocker',
                    room_id: room,
                    sender: owner,
                    encrypted: true,
                    type: 'm.room.message',
                    content: {msgtype: 'm.text', body: 'Earlier text'},
                },
            ]);
            const blocker = createRequestId();
            outbox.prepare({
                requestId: blocker,
                profile,
                sender: owner,
                roomId: room,
                chatId: chat,
                eventId: '$blocker',
                transactionId: 'blocker',
                text: 'Earlier text',
            });
            outbox.claim(blocker);
            outbox.recordIds(blocker, ['m:0200000000000000']);
            inbox.accept('edit', {});
            inbox.complete('edit', [
                {
                    event_id: '$edit',
                    room_id: room,
                    sender: owner,
                    encrypted: true,
                    type: 'm.room.message',
                    content: {
                        'msgtype': 'm.text',
                        'body': '* Edited',
                        'm.relates_to': {rel_type: 'm.replace', event_id: '$text'},
                        'm.new_content': {msgtype: 'm.text', body: 'Edited'},
                    },
                },
            ]);
            assert.equal(await notices.drain(), 0);
            await assert.rejects(runtime.drain(), /requires retry/);
            assert.deepEqual(calls, []);
            assert.deepEqual(outbox.mutations.get(profile, '$edit')!.states, ['PREPARED']);
            outbox.sent(blocker, ['m:0200000000000000']);
            inbox.acknowledgeEvent('$blocker');
            authorized = false;
            await assert.rejects(runtime.drain());
            assert.deepEqual(
                calls,
                [],
                'Fresh room authorization is required after predecessor settles',
            );
            authorized = true;
            if (lostResponse) await assert.rejects(runtime.drain());
            else await runtime.drain();
            assert.deepEqual(calls, ['edit']);
            assert.deepEqual(outbox.mutations.get(profile, '$edit')!.states, [
                lostResponse ? 'OUTCOME_UNKNOWN' : 'APPLIED',
            ]);
            inbox.accept('delete', {});
            inbox.complete('delete', [
                {
                    event_id: '$delete',
                    room_id: room,
                    sender: owner,
                    type: 'm.room.redaction',
                    redacts: '$text',
                    content: {},
                },
            ]);
            assert.equal(await notices.drain(), 0);
            if (lostResponse) {
                await runtime.drain();
                assert.deepEqual(
                    calls,
                    ['edit'],
                    'Mismatched native state does not resend or release deletion',
                );
                assert.deepEqual(outbox.mutations.get(profile, '$delete')!.states, ['PREPARED']);
                assert.equal(failures.length, 0, 'An uncertain result is not a policy rejection');
                const checked = queries;
                observed = true;
                authorized = false;
                await assert.rejects(runtime.drain());
                assert.equal(queries, checked, 'Revoked access prevents native state reads');
                assert.deepEqual(calls, ['edit']);
                authorized = true;
            }
            await runtime.drain();
            assert.deepEqual(outbox.mutations.get(profile, '$edit')!.states, ['APPLIED']);
            assert.deepEqual(calls, ['edit', 'delete']);
            assert.equal(failures.length, 1);
            assert.match(failures[0]!, /time limit for deleting/);
            assert.deepEqual(outbox.mutations.get(profile, '$delete')!.states, ['REJECTED']);
            assert.equal(inbox.pendingEvents().length, 0);
            await runtime.drain();
            assert.deepEqual(calls, ['edit', 'delete']);
            assert.equal(failures.length, 1);
        } finally {
            inbox.close();
            portals.close();
            outbox.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });

for (const stage of ['authorization', 'state'] as const)
    await test(`mutation shutdown interrupts stalled ${stage} without late settlement`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'mutation-abort-')),
            key = randomBytes(32);
        const outbox = new OutboxStore(join(directory, 'outbox'), key),
            portals = new PortalStore(join(directory, 'portals'), key),
            inbox = new TransactionInbox(join(directory, 'inbox'), key);
        const profile = 'SELF1234',
            owner = '@owner:invalid',
            room = '!room:invalid',
            chat = 'c:ABCD1234';
        let entered!: () => void, release!: (value: any) => void;
        const began = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const stall = () => {
            entered();
            return new Promise<any>((resolve) => {
                release = resolve;
            });
        };
        const abort = new AbortController();
        const state = [
            {
                type: 'm.room.encryption',
                state_key: '',
                content: {algorithm: 'm.megolm.v1.aes-sha2'},
            },
            {
                type: 'm.bridge',
                state_key: 'threema://bridge',
                sender: '@bot:invalid',
                content: {creator: owner, network: {id: profile}, channel: {id: chat}},
            },
            {type: 'm.room.member', state_key: owner, content: {membership: 'join'}},
        ];
        try {
            portals.bind(profile, chat, room);
            outbox.mutations.prepare({
                profile,
                owner,
                room,
                chat,
                event: '$edit',
                target: '$original',
                commands: [
                    {
                        profile,
                        chatId: chat,
                        messageId: 'm:0100000000000000',
                        action: 'edit',
                        text: 'new',
                    },
                ],
            });
            assert(outbox.mutations.claim(profile, '$edit', 0));
            outbox.recoverInterrupted();
            const runtime = createMutationRuntime({
                profile,
                owner,
                portals,
                outbox,
                inbox,
                signal: abort.signal,
                ready: () => true,
                bot: {
                    userId: '@bot:invalid',
                    underlyingClient: {
                        getRoomState: async () => (stage === 'authorization' ? stall() : state),
                    },
                },
                original: async () => undefined,
                send: async () => {
                    assert.fail('No notice expected');
                },
                backend: {
                    mutationState: async () => stall(),
                    mutateMessage: async () => {
                        assert.fail('Uncertain edit must not be resent');
                    },
                },
            });
            const pending = assert.rejects(runtime.drain());
            await began;
            abort.abort();
            await pending;
            assert.equal(await runtime.drain(), 0);
            release(stage === 'authorization' ? state : true);
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(outbox.mutations.get(profile, '$edit')!.states, ['OUTCOME_UNKNOWN']);
        } finally {
            outbox.close();
            inbox.close();
            portals.close();
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });

await test('mutation read deadline allows another chat to recover and ignores late results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-deadline-'));
    const key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid';
    const chats = ['c:ABCD1234', 'c:EFGH5678'];
    let release!: (matches: boolean) => void;
    const queries: string[] = [];
    try {
        for (const [index, chat] of chats.entries()) {
            const room = `!room${index}:invalid`;
            portals.bind(profile, chat, room);
            outbox.mutations.prepare({
                profile,
                owner,
                room,
                chat,
                event: `$edit${index}`,
                target: `$original${index}`,
                commands: [
                    {
                        profile,
                        chatId: chat,
                        messageId: 'm:0100000000000000',
                        action: 'edit',
                        text: 'new',
                    },
                ],
            });
            assert(outbox.mutations.claim(profile, `$edit${index}`, 0));
        }
        outbox.recoverInterrupted();
        const runtime = createMutationRuntime({
            profile,
            owner,
            portals,
            outbox,
            inbox,
            ready: () => true,
            readTimeoutMs: 25,
            bot: {
                userId: '@bot:invalid',
                underlyingClient: {
                    getRoomState: async (room) =>
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
                                    channel: {id: room === '!room0:invalid' ? chats[0] : chats[1]},
                                },
                            },
                            {
                                type: 'm.room.member',
                                state_key: owner,
                                content: {membership: 'join'},
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
            original: async () => undefined,
            send: async () => assert.fail('Recovery does not send rejection notices'),
            backend: {
                mutateMessage: async () => assert.fail('Uncertain mutations must not be resent'),
                mutationState: async (request) => {
                    queries.push(request.chatId);
                    if (request.chatId === chats[0])
                        return new Promise<boolean>((resolve) => {
                            release = resolve;
                        });
                    return true;
                },
            },
        });
        await assert.rejects(runtime.drain(), /requires retry or recovery/);
        assert.deepEqual(queries, chats);
        assert.deepEqual(outbox.mutations.get(profile, '$edit0')!.states, ['OUTCOME_UNKNOWN']);
        assert.deepEqual(outbox.mutations.get(profile, '$edit1')!.states, ['APPLIED']);
        release(true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(outbox.mutations.get(profile, '$edit0')!.states, ['OUTCOME_UNKNOWN']);
    } finally {
        outbox.close();
        portals.close();
        inbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
