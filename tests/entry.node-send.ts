import {MessageChannel} from 'node:worker_threads';
import {SendAllocation, acceptSendAllocation} from '../src/threema/send-allocation.ts';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {OutboxStore, type TextRequest} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';

// The actual built endpoint service and controller exercise serialization in both directions.
const runtime = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
await test('backend text adapter persists canonical IDs through a real Desktop proxy before insertion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-node-send-'));
    const key = randomBytes(32),
        store = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const request: TextRequest = {
        requestId: '01900000-0000-7000-8000-000000000001',
        profile: 'SELF1234',
        transactionId: 'txn',
        eventId: '$event',
        roomId: '!room:invalid',
        sender: '@owner:invalid',
        chatId: 'c:TEST1234',
        text: 'proxy fixture',
        replyTo: 'm:feffffffffffffff',
    };
    const endpoint = runtime.ProbeEndpointService({
        logging: {logger: () => runtime.ProbeNoopLogger},
    });
    const pair = endpoint.createEndpointPair();
    let inserted = 0;
    const context = {
        _sendFragmentsWithIds: runtime.ProbeSendController.prototype._sendFragmentsWithIds,
        _services: {
            crypto: {
                randomBytes(view: Uint8Array) {
                    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(255);
                    return view;
                },
            },
        },
        _log: {debug() {}},
        _conversation: {
            get: () => ({
                controller: {
                    addMessage: {
                        fromLocal: async (message: {id: bigint; quotedMessageId: bigint}) => {
                            assert.deepEqual(store.get(request.requestId)!.ids, [
                                'm:ffffffffffffffff',
                            ]);
                            assert.equal(message.id, 0xffffffffffffffffn);
                            assert.equal(message.quotedMessageId, 0xfffffffffffffffen);
                            inserted++;
                        },
                    },
                },
            }),
        },
    };
    endpoint.exposeProxy(
        {
            [runtime.ProbeTransferHandler]: runtime.ProbeProxyHandler,
            async sendMessageWithIds(detail: unknown, hook: any) {
                try {
                    return await runtime.ProbeSendController.prototype.sendMessageWithIds.call(
                        context,
                        detail,
                        hook,
                    );
                } finally {
                    hook[runtime.ProbeReleaseProxy]();
                }
            },
        },
        pair.local,
    );
    const controller = endpoint.wrap(pair.remote, runtime.ProbeNoopLogger);
    const conversation = {
        get: () => ({
            controller: {
                receiver: async () => ({
                    get: () => ({
                        type: runtime.ProbeReceiverType.CONTACT,
                        view: {identity: 'TEST1234'},
                    }),
                }),
                receiverLookup: {type: runtime.ProbeReceiverType.CONTACT, uid: 1},
            },
        }),
    };
    const handle = {
        model: {
            user: {identity: request.profile},
            conversations: {getAll: async () => ({get: () => new Set([conversation])})},
        },
        viewModel: {conversation: async () => ({viewModelController: controller})},
    };
    try {
        store.prepare(request);
        const worker = new OutboxWorker(
            store,
            {
                send: async (value, beforeSend) => {
                    const {port1, port2} = new MessageChannel();
                    const parent = acceptSendAllocation(port1, beforeSend);
                    const barrier = new SendAllocation(port2);
                    try {
                        return parent.result(
                            await runtime.sendNodeText(handle, value, (ids: readonly string[]) =>
                                barrier.record(ids),
                            ),
                        );
                    } finally {
                        barrier.close();
                        parent.close();
                    }
                },
            },
            () => true,
        );
        assert.equal(await worker.flushOne(), true);
        assert.equal(inserted, 1);
        assert.equal(store.get(request.requestId)!.state, 'SENT');
        await assert.rejects(
            runtime.sendNodeText(handle, {...request, profile: 'OTHER123'}, async () => {}),
            /NOT_AUTHORIZED/,
        );
        await assert.rejects(
            runtime.sendNodeText(
                handle,
                {...request, text: 'x'.repeat(1024 * 1024)},
                async () => {},
            ),
            /INVALID_ARGUMENT/,
        );
        await assert.rejects(
            runtime.sendNodeText(handle, request, async () => {
                throw new Error('synthetic persistence failure');
            }),
            /synthetic persistence failure/,
        );
        assert.equal(inserted, 1);
    } finally {
        controller[runtime.ProbeReleaseProxy]();
        pair.local.close();
        pair.remote.close();
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('worker-local text controller retains its receiver and persists before insertion', async () => {
    let persisted = false,
        inserted = false;
    const controller = {
        sendMessageWithIds: runtime.ProbeSendController.prototype.sendMessageWithIds,
        _sendFragmentsWithIds: runtime.ProbeSendController.prototype._sendFragmentsWithIds,
        _services: {
            crypto: {
                randomBytes: (v: Uint8Array) => {
                    new Uint8Array(v.buffer, v.byteOffset, v.byteLength).fill(1);
                    return v;
                },
            },
        },
        _log: {debug() {}},
        _conversation: {
            get: () => ({
                controller: {
                    addMessage: {
                        fromLocal: async () => {
                            assert.equal(persisted, true);
                            inserted = true;
                        },
                    },
                },
            }),
        },
    };
    const receiver = {type: runtime.ProbeReceiverType.CONTACT, view: {identity: 'TEST1234'}};
    const conversation = {
        get: () => ({
            controller: {
                receiver: async () => ({get: () => receiver}),
                receiverLookup: {type: receiver.type, uid: 1},
            },
        }),
    };
    const handle = {
        model: {
            user: {identity: 'SELF1234'},
            conversations: {getAll: async () => ({get: () => new Set([conversation])})},
        },
        viewModel: {conversation: async () => ({viewModelController: controller})},
    };
    await runtime.sendNodeText(
        handle,
        {profile: 'SELF1234', chatId: 'c:TEST1234', text: 'local controller fixture'},
        async (ids: string[]) => {
            assert.equal(ids.length, 1);
            persisted = true;
        },
    );
    assert.equal(inserted, true);
});
