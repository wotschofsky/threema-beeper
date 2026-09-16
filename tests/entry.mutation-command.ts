import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {parseMutationCommand} from '../src/threema/mutation-command.ts';
import {BackendController} from '../src/threema/backend-controller.ts';
const {mutateNodeMessage, readNodeMutation, ProbeReceiverType} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const target = {profile: 'SELF1234', chatId: 'c:ABCD1234', messageId: 'm:0100000000000000'};
await test('mutation command snapshots targets and rejects ambiguous payloads', async () => {
    const source = {...target, action: 'edit' as const, text: 'line one\n🙂'};
    const parsed = parseMutationCommand(source);
    source.text = 'changed';
    assert.equal(parsed.action === 'edit' && parsed.text, 'line one\n🙂');
    for (const value of [
        null,
        {...source, text: '🙂'.repeat(1501)},
        {...target, action: 'delete', text: ''},
        {...source, now: 1},
        {...source, profile: 12345678},
        {...target, action: {toString: () => 'delete'}},
    ])
        assert.throws(() => parseMutationCommand(value));
    assert.equal(parseMutationCommand({...source, text: '🙂'.repeat(1500)}).action, 'edit');
    const calls: unknown[] = [];
    await BackendController.prototype.mutateMessage.call(
        {
            request: async (...args: unknown[]) => {
                calls.push(args);
            },
        } as any,
        {...target, action: 'delete'},
    );
    assert.deepEqual(calls, [['mutate-message', undefined, {...target, action: 'delete'}]]);
    assert.equal(
        await BackendController.prototype.mutationState.call({request: async () => true} as any, {
            ...target,
            action: 'delete',
        }),
        true,
    );
    await assert.rejects(
        BackendController.prototype.mutationState.call({request: async () => 'true'} as any, {
            ...target,
            action: 'delete',
        }),
        /Invalid mutation state/,
    );
});
await test('native edits and deletes enforce ownership, sent status, capabilities and upstream windows', async () => {
    let type = 'text',
        direction = 1,
        sentAt: Date | undefined = new Date(),
        feature = true,
        missing = false;
    let receiver: any = {type: 0, view: {identity: 'ABCD1234'}};
    const calls: unknown[] = [];
    const model = {
        get: () => ({
            type,
            ctx: direction,
            view: {sentAt, text: 'old', caption: 'caption'},
            controller: {
                editMessage: {
                    fromLocal: async (value: unknown) => {
                        calls.push(['edit', value]);
                    },
                },
            },
        }),
    };
    const controller = {
        receiver: async () => ({get: () => receiver}),
        receiverLookup: {},
        getMessage: async (id: bigint) => {
            assert.equal(id, 1n);
            return missing ? undefined : model;
        },
        markMessageAsDeleted: {
            fromLocal: async (id: bigint, at: Date) => {
                calls.push(['delete', id, at]);
            },
        },
    };
    const handle = {
        model: {
            user: {identity: 'SELF1234'},
            conversations: {getAll: async () => ({get: () => [{get: () => ({controller})}]})},
        },
        viewModel: {
            conversation: async () => ({
                viewModelStore: {
                    get: () => ({
                        supportedFeatures: new Map([
                            [0x100n, {supported: feature}],
                            [0x200n, {supported: feature}],
                        ]),
                    }),
                },
            }),
        },
    };
    const edit = {...target, action: 'edit', text: 'new'};
    const remove = {...target, action: 'delete'};
    assert.equal(await readNodeMutation(handle, {...edit, text: 'old'}), true);
    assert.equal(await readNodeMutation(handle, edit), false);
    assert.equal(await readNodeMutation(handle, remove), false);
    type = 'deleted';
    assert.equal(await readNodeMutation(handle, remove), true);
    assert.equal(await readNodeMutation(handle, {...edit, text: 'old'}), false);
    type = 'text';
    direction = 0;
    assert.equal(await readNodeMutation(handle, {...edit, text: 'old'}), false);
    direction = 1;
    missing = true;
    assert.equal(await readNodeMutation(handle, remove), false);
    missing = false;
    await assert.rejects(readNodeMutation(handle, {...remove, profile: 'OTHER123'}), {
        type: 'mutation-permission-denied',
    });
    assert.equal(calls.length, 0, 'State queries never call a mutation controller');
    const reject = async (request: unknown, error: string) => {
        const before = calls.length;
        await assert.rejects(mutateNodeMessage(handle, request), {type: error});
        assert.equal(calls.length, before);
    };
    await mutateNodeMessage(handle, edit);
    await mutateNodeMessage(handle, remove);
    assert.equal(calls.length, 2);
    await mutateNodeMessage(handle, {...edit, text: 'old'});
    assert.equal(calls.length, 2, 'No-op edits do not schedule a task');
    await reject({...edit, profile: 'OTHER123'}, 'mutation-permission-denied');
    await reject({...edit, chatId: 'c:OTHER123'}, 'mutation-not-found');
    await reject({...edit, text: ''}, 'mutation-invalid');
    for (const text of [' \n\t', '\u00a0\u2003\ufeff'])
        await reject({...edit, text}, 'mutation-invalid');
    direction = 0;
    await reject(edit, 'mutation-permission-denied');
    await reject(remove, 'mutation-permission-denied');
    direction = 1;
    sentAt = undefined;
    await reject(edit, 'mutation-permission-denied');
    sentAt = new Date();
    feature = false;
    await reject(edit, 'mutation-unsupported');
    await reject(remove, 'mutation-unsupported');
    feature = true;
    missing = true;
    await reject(edit, 'mutation-not-found');
    missing = false;
    for (type of ['audio', 'poll']) await reject(edit, 'mutation-unsupported');
    type = 'deleted';
    await reject(remove, 'mutation-not-found');
    type = 'file';
    await mutateNodeMessage(handle, {...edit, text: ''});
    type = 'text';
    sentAt = new Date(Date.now() - 360 * 60000);
    await reject(edit, 'edit-window-expired');
    await reject(remove, 'delete-window-expired');
    receiver = {
        type: ProbeReceiverType.GROUP,
        view: {creator: 'me', groupId: 1n, members: new Set(), userState: 0},
    };
    const notes = {...target, chatId: 'g:SELF1234:0100000000000000'};
    await mutateNodeMessage(handle, {...notes, action: 'edit', text: 'old notes'});
    await mutateNodeMessage(handle, {...notes, action: 'delete'});
    receiver.view.members.add({});
    await reject({...notes, action: 'edit', text: 'expired'}, 'edit-window-expired');
    receiver.view.members.clear();
    receiver.view.userState = 2;
    await reject({...notes, action: 'delete'}, 'mutation-permission-denied');
});

await test('native text model commits edit history only after its outgoing task completes', async () => {
    const {ProbeOutboundTextStore, ProbeOutgoingEditTask, ProbeNoopLogger} = createRequire(
        import.meta.url,
    )('../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs');
    const writes: unknown[][] = [];
    const tasks: any[] = [];
    let release!: () => void;
    let reject!: (error: Error) => void;
    const services = {
        logging: {logger: () => ProbeNoopLogger},
        db: {
            editMessage: (...args: unknown[]) => {
                writes.push(args);
            },
        },
        taskManager: {
            schedule: (task: unknown) => {
                tasks.push(task);
                return new Promise<void>((resolve, fail) => {
                    release = resolve;
                    reject = fail;
                });
            },
        },
    };
    const receiver = {
        get: () => ({
            type: 0,
            view: {identity: 'ABCD1234'},
            controller: {conversation: () => conversation},
        }),
    };
    const conversation = {get: () => ({controller: {getMessage: () => store}})};
    const createdAt = new Date(1000),
        sentAt = new Date(2000),
        editedAt = new Date(3000);
    const store = new ProbeOutboundTextStore(
        services,
        {
            id: 1n,
            text: 'original',
            createdAt,
            sentAt,
            history: [],
            reactions: [],
        },
        7n,
        {uid: 2n, getReceiver: () => receiver},
    );
    const editing = store
        .get()
        .controller.editMessage.fromLocal({newText: 'changed', lastEditedAt: editedAt});
    assert.equal(tasks.length, 1);
    assert(tasks[0] instanceof ProbeOutgoingEditTask);
    assert.equal(tasks[0].persist, true);
    assert.equal(store.get().view.text, 'original');
    assert.equal(writes.length, 0);
    release();
    await editing;
    assert.equal(store.get().view.text, 'changed');
    assert.deepEqual(store.get().view.history, [
        {text: 'original', editedAt: createdAt},
        {text: 'changed', editedAt},
    ]);
    assert.deepEqual(writes, [[7n, 'text', {text: 'changed', lastEditedAt: editedAt}]]);
    const failed = store
        .get()
        .controller.editMessage.fromLocal({newText: 'failed', lastEditedAt: new Date(4000)});
    const failure = assert.rejects(failed, /synthetic task failure/);
    reject(new Error('synthetic task failure'));
    await failure;
    assert.equal(store.get().view.text, 'changed');
    assert.equal(writes.length, 1);
    await store
        .get()
        .controller.editMessage.fromLocal({newText: ' \n\t', lastEditedAt: new Date(5000)});
    assert.equal(tasks.length, 2, 'Native whitespace rejection does not schedule a task');

    const live = new ProbeOutboundTextStore(
        services,
        {
            id: 1n,
            text: 'before bridge edit',
            createdAt: new Date(),
            sentAt: new Date(),
            history: [],
            reactions: [],
        },
        8n,
        {uid: 2n, getReceiver: () => receiver},
    );
    const bridgeConversation = {
        get: () => ({
            controller: {
                receiver: async () => receiver,
                receiverLookup: {type: 0, uid: 2n},
                getMessage: async (id: bigint) => {
                    assert.equal(id, 1n);
                    return live;
                },
            },
        }),
    };
    const handle = {
        model: {
            user: {identity: target.profile},
            conversations: {getAll: async () => ({get: () => new Set([bridgeConversation])})},
        },
        viewModel: {
            conversation: async () => ({
                viewModelStore: {
                    get: () => ({supportedFeatures: new Map([[0x100n, {supported: true}]])}),
                },
            }),
        },
    };
    let settled = false;
    const throughBridge = mutateNodeMessage(handle, {
        ...target,
        action: 'edit',
        text: 'through bridge',
    }).then(() => {
        settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tasks.length, 3);
    assert.equal(settled, false);
    assert.equal(live.get().view.text, 'before bridge edit');
    release();
    await throughBridge;
    assert.equal(live.get().view.text, 'through bridge');
    assert.equal(live.get().view.history.length, 2);
    await mutateNodeMessage(handle, {...target, action: 'edit', text: 'through bridge'});
    assert.equal(tasks.length, 3, 'Bridge no-op avoids native duplicate history and task');
    const bridgeFailure = assert.rejects(
        mutateNodeMessage(handle, {...target, action: 'edit', text: 'not applied'}),
        /synthetic bridge task failure/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    reject(new Error('synthetic bridge task failure'));
    await bridgeFailure;
    assert.equal(live.get().view.text, 'through bridge');
    assert.equal(live.get().view.history.length, 2);
});

await test('native mutation tasks encode original targets for contacts and groups', async () => {
    const {
        ProbeOutgoingEditTask,
        ProbeOutgoingDeleteTask,
        ProbeOutgoingCspTask,
        ProbeNoopLogger,
        ProbeMutationProtobuf: protobuf,
        ProbeMutationStructbuf: structbuf,
        ProbeMutationType,
        ProbeGroupMutationType,
    } = createRequire(import.meta.url)(
        '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
    );
    const originalRun = ProbeOutgoingCspTask.prototype.run;
    const emitted: any[] = [];
    const services = {
        logging: {logger: () => ProbeNoopLogger},
        crypto: {
            randomBytes: (array: Uint8Array) => {
                new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(17);
                return array;
            },
        },
        nonces: {getRandomNonce: () => ({nonce: new Uint8Array(24), commit: () => {}})},
        device: {identity: {string: 'SELF1234'}},
    };
    const message = {
        type: 'text',
        get: () => ({ctx: 1, view: {id: 0x12345678n, sentAt: new Date(1)}}),
    };
    const conversation = {get: () => ({controller: {getMessage: () => message}})};
    const contact = {type: ProbeReceiverType.CONTACT, view: {identity: 'ABCD1234'}};
    const group = {
        type: ProbeReceiverType.GROUP,
        view: {creator: 'me', groupId: 5n, members: new Set([{get: () => contact}])},
    };
    const date = new Date(12345);
    try {
        ProbeOutgoingCspTask.prototype.run = async function () {
            emitted.push(...this._messages);
        };
        for (const receiver of [contact, group]) {
            for (const action of ['edit', 'delete']) {
                const task =
                    action === 'edit'
                        ? new ProbeOutgoingEditTask(services, receiver, conversation, 0x12345678n, {
                              newText: 'edited 🙂',
                              lastEditedAt: date,
                          })
                        : new ProbeOutgoingDeleteTask(services, receiver, message, date);
                assert.equal(task.persist, true);
                await task.run({});
                const row = emitted.at(-1);
                assert.equal(row.properties.createdAt, date);
                assert.notEqual(row.properties.messageId, 0x12345678n);
                assert.equal(row.properties.allowUserProfileDistribution, false);
                const specific = row.specifics.default;
                const types = receiver === group ? ProbeGroupMutationType : ProbeMutationType;
                assert.equal(
                    specific.messageProperties.type,
                    types[
                        (receiver === group ? 'GROUP_' : '') +
                            (action === 'edit' ? 'EDIT_MESSAGE' : 'DELETE_MESSAGE')
                    ],
                );
                let bytes = specific.encoder.encode(new Uint8Array(specific.encoder.byteLength()));
                if (receiver === group) {
                    const envelope = structbuf.csp.e2e.GroupMemberContainer.decode(bytes);
                    assert.equal(envelope.groupId, 5n);
                    assert.equal(Buffer.from(envelope.creatorIdentity).toString(), 'SELF1234');
                    bytes = envelope.innerData;
                }
                const decoded = (
                    action === 'edit'
                        ? protobuf.csp_e2e.EditMessage
                        : protobuf.csp_e2e.DeleteMessage
                ).decode(bytes);
                assert.equal(decoded.messageId.toString(), String(0x12345678n));
                if (action === 'edit') assert.equal(decoded.text, 'edited 🙂');
            }
        }
        assert.equal(emitted.length, 4);
        ProbeOutgoingCspTask.prototype.run = async () => {
            throw new Error('Synthetic CSP failure');
        };
        await assert.rejects(
            new ProbeOutgoingDeleteTask(services, contact, message, date).run({}),
            /Synthetic CSP failure/,
        );
        await assert.rejects(
            new ProbeOutgoingEditTask(services, contact, conversation, 0x12345678n, {
                newText: 'failed',
                lastEditedAt: date,
            }).run({}),
            /Synthetic CSP failure/,
        );
    } finally {
        ProbeOutgoingCspTask.prototype.run = originalRun;
    }
});

await test('native deletion replaces the model only after its outgoing task completes', async () => {
    const {ProbeConversationStore, ProbeOutgoingDeleteTask, ProbeNoopLogger} = createRequire(
        import.meta.url,
    )('../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs');
    let row: any = {
        uid: 901n,
        id: 9n,
        type: 'text',
        text: 'private original',
        createdAt: new Date(1),
        processedAt: new Date(2),
        ordinal: 1,
        history: [],
        reactions: [],
    };
    const tasks: any[] = [];
    let release!: () => void;
    let reject!: (error: Error) => void;
    let writes = 0;
    const services = {
        logging: {logger: () => ProbeNoopLogger},
        file: {},
        db: {
            getLastMessage: () => row,
            getLastStatusMessage: () => undefined,
            hasMessageById: () => row.uid,
            getMessage: () => row,
            markMessageAsDeleted: (_conversation: bigint, uid: bigint, deletedAt: Date) => {
                assert.equal(uid, 901n);
                writes++;
                row = {
                    uid,
                    id: row.id,
                    type: 'deleted',
                    createdAt: row.createdAt,
                    processedAt: row.processedAt,
                    ordinal: 1,
                    deletedAt,
                };
                return {deletedMessage: row, deletedFileIds: []};
            },
        },
        taskManager: {
            schedule: (task: unknown) => {
                tasks.push(task);
                return new Promise<void>((ok, fail) => {
                    release = ok;
                    reject = fail;
                });
            },
        },
    };
    const conversation = new ProbeConversationStore(
        services,
        {type: 0, uid: 55n},
        {unreadMessageCount: 0},
        900n,
        'deletion-fixture',
    );
    const controller = conversation.get().controller;
    controller.receiver = () => ({get: () => ({type: 0, view: {identity: 'ABCD1234'}})});
    const original = controller.lastMessageStore().get();
    const deletedAt = new Date(3000);
    const failure = controller.markMessageAsDeleted.fromLocal(9n, deletedAt);
    const failed = assert.rejects(failure, /synthetic deletion failure/);
    await new Promise((resolve) => setImmediate(resolve));
    assert(tasks[0] instanceof ProbeOutgoingDeleteTask);
    assert.equal(writes, 0);
    reject(new Error('synthetic deletion failure'));
    await failed;
    assert.equal(original.get().controller.lifetimeGuard.active.get(), true);
    assert.equal(controller.lastMessageStore().get().type, 'text');
    const deleting = controller.markMessageAsDeleted.fromLocal(9n, deletedAt);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 0);
    release();
    await deleting;
    assert.equal(writes, 1);
    assert.equal(original.get().controller.lifetimeGuard.active.get(), false);
    const deleted = controller.lastMessageStore().get();
    assert.equal(deleted.type, 'deleted');
    assert.equal(deleted.get().view.deletedAt, deletedAt);
    assert.equal(deleted.get().view.text, undefined);
    assert.deepEqual(deleted.get().view.history, []);
    await controller.markMessageAsDeleted.fromLocal(9n, new Date(4000));
    assert.equal(tasks.length, 2);
    assert.equal(writes, 1);
});
