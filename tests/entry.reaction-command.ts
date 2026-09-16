import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {BackendController} from '../src/threema/backend-controller.ts';
import {parseReactionCommand} from '../src/threema/reaction-command.ts';
const {reactNodeMessage, readNodeReaction} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const request = {
    profile: 'SELF1234',
    chatId: 'c:ABCD1234',
    messageId: 'm:0100000000000000',
    emoji: '👍',
    action: 'apply' as const,
};
await test('reaction controller uses upstream emoji validation and applies/withdraws on the resolved message', async () => {
    const calls: string[] = [];
    let type = 'text';
    const reactions = [{senderIdentity: 'OTHER123', reaction: '👍'}];
    const model = {
        get: () => ({
            type,
            view: {reactions},
            controller: {
                addReaction: {
                    fromLocal: async (emoji: string) => {
                        calls.push('apply:' + emoji);
                    },
                },
                withdrawReaction: {
                    fromLocal: async (emoji: string) => {
                        calls.push('withdraw:' + emoji);
                    },
                },
            },
        }),
    };
    let receiver: any = {type: 0, view: {identity: 'ABCD1234'}};
    const handle = {
        model: {
            user: {identity: 'SELF1234'},
            conversations: {
                getAll: async () => ({
                    get: () => [
                        {
                            get: () => ({
                                controller: {
                                    receiver: async () => ({
                                        get: () => receiver,
                                    }),
                                    getMessage: async (id: bigint) => {
                                        assert.equal(id, 1n);
                                        return model;
                                    },
                                },
                            }),
                        },
                    ],
                }),
            },
        },
    };
    assert.equal(await readNodeReaction(handle, request), false);
    reactions.push({senderIdentity: 'SELF1234', reaction: '👍'});
    assert.equal(await readNodeReaction(handle, request), true);
    assert.equal(calls.length, 0);
    await reactNodeMessage(handle, request);
    await reactNodeMessage(handle, {...request, action: 'withdraw'});
    assert.deepEqual(calls, ['apply:👍', 'withdraw:👍']);
    for (const changed of [
        {emoji: 'text'},
        {emoji: '👍👍'},
        {profile: 'OTHER123'},
        {chatId: 'c:OTHER123'},
    ])
        await assert.rejects(reactNodeMessage(handle, {...request, ...changed}));
    type = 'deleted';
    assert.equal(
        await readNodeReaction(handle, request),
        false,
        'A retained deletion tombstone has no active reaction',
    );
    await assert.rejects(
        readNodeReaction(handle, {...request, chatId: 'c:OTHER123'}),
        'Missing conversations must not be interpreted as confirmed reaction absence',
    );
    await assert.rejects(reactNodeMessage(handle, request));
    assert.equal(calls.length, 2);
    assert.throws(() => parseReactionCommand({...request, unexpected: true}));
    type = 'text';
    receiver = {type: 2, view: {creator: 'me', groupId: 1n, userState: 2}};
    const groupRequest = {...request, chatId: 'g:SELF1234:0100000000000000'};
    assert.equal(
        await readNodeReaction(handle, groupRequest),
        true,
        'Retained left-group state remains readable',
    );
    await assert.rejects(reactNodeMessage(handle, groupRequest), {
        type: 'reaction-permission-denied',
    });
    assert.equal(calls.length, 2);
});
await test('contact and reaction IPC put payload in command data, never the password field', async () => {
    const calls: unknown[][] = [];
    const target = {
        request: async (...args: unknown[]) => {
            calls.push(args);
            return {
                identity: 'ABCD1234',
                firstName: '',
                lastName: '',
                displayName: '',
                verification: 0,
                activity: 0,
                blocked: false,
            };
        },
    } as unknown as BackendController;
    await BackendController.prototype.ensureContact.call(target, 'abcd1234');
    await BackendController.prototype.reactMessage.call(target, request);
    assert.deepEqual(calls, [
        ['ensure-contact', undefined, 'ABCD1234'],
        ['react-message', undefined, request],
    ]);
});
