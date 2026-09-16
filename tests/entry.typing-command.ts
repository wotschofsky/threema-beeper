import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {parseTypingCommand} from '../src/threema/typing-command.ts';
import {BackendController} from '../src/threema/backend-controller.ts';
const {setNodeTyping, ProbeReceiverType, ProbeConnectionState} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const request = {profile: 'SELF1234', chatId: 'c:ABCD1234', typing: true};
await test('typing commands require exact transient boolean payloads and route through the worker controller', async () => {
    const parsed = parseTypingCommand(request);
    assert.notEqual(parsed, request);
    for (const value of [
        null,
        {...request, typing: 'true'},
        {...request, expires: 1},
        {...request, profile: 'foreign'},
        {...request, chatId: '!room:invalid'},
    ])
        assert.throws(() => parseTypingCommand(value));
    const calls: unknown[] = [];
    await BackendController.prototype.setTyping.call(
        {
            request: async (...args: unknown[]) => {
                calls.push(args);
            },
        } as any,
        request,
    );
    assert.deepEqual(calls, [['set-typing', undefined, request]]);
});
await test('native typing resolves the owned contact and delegates to upstream local privacy/timer handling', async () => {
    const calls: boolean[] = [];
    let receiver: any = {type: ProbeReceiverType.CONTACT, view: {identity: 'ABCD1234'}};
    let connection = ProbeConnectionState.CONNECTED;
    const handle = {
        connectionManager: {state: {get: () => connection}},
        model: {
            user: {identity: 'SELF1234'},
            conversations: {
                getAll: async () => ({
                    get: () => [
                        {
                            get: () => ({
                                controller: {
                                    receiver: async () => ({get: () => receiver}),
                                    updateTyping: {
                                        fromLocal: async (value: boolean) => {
                                            calls.push(value);
                                        },
                                    },
                                },
                            }),
                        },
                    ],
                }),
            },
        },
    };
    await setNodeTyping(handle, request);
    await setNodeTyping(handle, {...request, typing: false});
    assert.deepEqual(calls, [true, false]);
    await assert.rejects(
        setNodeTyping(handle, {...request, profile: 'ELSE1234'}),
        /profile mismatch/,
    );
    await assert.rejects(setNodeTyping(handle, {...request, chatId: 'c:ELSE1234'}), /unavailable/);
    receiver = {type: ProbeReceiverType.GROUP, view: {creator: 'me', groupId: 1n}};
    await assert.rejects(
        setNodeTyping(handle, {...request, chatId: 'g:SELF1234:0100000000000000'}),
        /unsupported/,
    );
    assert.deepEqual(calls, [true, false]);
    connection = ProbeConnectionState.DISCONNECTED;
    await assert.rejects(setNodeTyping(handle, request), /connection unavailable/);
    assert.deepEqual(calls, [true, false]);
});

await test('incoming native typing follows model changes and clears on disconnect and removal', async () => {
    const {watchNodeTyping, ProbeWritableStore, ProbeSetStore} = createRequire(import.meta.url)(
        '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
    );
    const connection = new ProbeWritableStore(ProbeConnectionState.CONNECTED);
    const model = (typing: boolean) => ({
        view: {isTyping: typing},
        controller: {
            receiver: async () => ({
                get: () => ({
                    type: ProbeReceiverType.CONTACT,
                    view: {identity: 'ABCD1234'},
                }),
            }),
        },
    });
    const conversation = new ProbeWritableStore(model(false));
    const conversations = new ProbeSetStore(new Set([conversation]));
    const handle = {
        connectionManager: {state: connection},
        model: {user: {identity: 'SELF1234'}, conversations: {getAll: async () => conversations}},
    };
    const values: boolean[] = [];
    const stop = await watchNodeTyping(handle, 'c:ABCD1234', (value: boolean) =>
        values.push(value),
    );
    try {
        conversation.set(model(true));
        conversation.set(model(true));
        connection.set(ProbeConnectionState.DISCONNECTED);
        connection.set(ProbeConnectionState.CONNECTED);
        conversation.set(model(true));
        assert.deepEqual(
            values,
            [false, true, false],
            'cached true does not replay after reconnect',
        );
        conversation.set(model(false));
        conversation.set(model(true));
        assert.deepEqual(values, [false, true, false, true]);
        conversations.clear();
        assert.deepEqual(values, [false, true, false, true, false]);
        conversation.set(model(false));
        conversation.set(model(true));
        assert.equal(values.length, 5);
    } finally {
        await stop();
    }
    await assert.rejects(
        watchNodeTyping(handle, 'g:SELF1234:0100000000000000', () => {}),
        /Invalid/,
    );
});
