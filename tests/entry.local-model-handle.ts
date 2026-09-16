import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MessageChannel, Worker, isMainThread, workerData} from 'node:worker_threads';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const native = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);

async function check(operation: 'open' | 'link'): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'threema-local-model-'));
    const method = operation === 'open' ? 'createFromKeyStorage' : 'createFromDeviceJoin';
    const original = native.backend[method];
    const pair = new MessageChannel();
    const member = {get: () => ({view: {identity: 'TEST1234'}})};
    const group = {
        type: 2,
        view: {
            creator: 'me',
            groupId: 1n,
            displayName: 'Fixture group',
            members: new Set([member]),
        },
    };
    // This is the real failure pattern: a raw group view embeds a live contact store.
    assert.throws(() => structuredClone(group.view), {name: 'DataCloneError'});
    const conversation = {
        get: () => ({
            view: {unreadMessageCount: 0},
            controller: {
                receiver: () => ({get: () => group}),
                lastMessageStore: () => ({get: () => undefined}),
            },
        }),
    };
    const handle = {
        model: {
            user: {identity: 'SELF1234'},
            conversations: {getAll: () => ({get: () => new Set([conversation])})},
        },
    };
    let endpointRequests = 0;
    pair.port2.on('message', () => endpointRequests++);
    native.backend[method] = async (...args: unknown[]) => {
        const capture = args.at(-1);
        assert.equal(typeof capture, 'function');
        (capture as (value: unknown) => void)(handle);
        return pair.port1;
    };
    const session = native.createNodeSession(
        directory,
        () => {},
        () => {},
    );
    try {
        await session[operation]('fixture-password');
        assert.equal(await session.identity(), 'SELF1234');
        const chats = await session.conversations();
        assert.deepEqual(
            chats.map((chat: {chatId: string}) => chat.chatId),
            ['g:SELF1234:0100000000000000'],
        );
        assert.equal(endpointRequests, 0);
    } finally {
        session.closeEndpoints();
        pair.port1.close();
        pair.port2.close();
        native.backend[method] = original;
        await rm(directory, {recursive: true, force: true});
    }
}
if (!isMainThread) {
    await check(workerData.operation);
} else {
    for (const operation of ['open', 'link'] as const) {
        test(
            `native ${operation} enumerates group models without cloning live member stores`,
            {timeout: 5000},
            async () => {
                const worker = new Worker(new URL(import.meta.url), {workerData: {operation}});
                try {
                    await new Promise<void>((resolve, reject) => {
                        worker.once('error', reject);
                        worker.once('exit', (code) =>
                            code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)),
                        );
                    });
                } finally {
                    await worker.terminate();
                }
            },
        );
    }
}
