import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {BackendController} from '../src/threema/backend-controller.ts';
await test('mutation state crosses the real worker router and reflects the native text model', async () => {
    for (const badStateResponse of [false, true]) {
        const backend = new BackendController(
            {profileDirectory: '/unused-synthetic-profile', wasmFile: ''},
            (_entry, options) =>
                new Worker(new URL('./fixtures/mutation-session-worker.ts', import.meta.url), {
                    ...options,
                    workerData: {...options.workerData, badStateResponse},
                }),
        );
        const target = {profile: 'SELF1234', chatId: 'c:ABCD1234', messageId: 'm:0100000000000000'};
        try {
            await backend.ready;
            if (badStateResponse) {
                await assert.rejects(
                    backend.mutationState({...target, action: 'delete'}),
                    /Invalid mutation state response/,
                );
                continue;
            }
            assert.equal(
                await backend.mutationState({...target, action: 'edit', text: 'original'}),
                true,
            );
            assert.equal(
                await backend.mutationState({...target, action: 'edit', text: 'changed'}),
                false,
            );
            await backend.mutateMessage({...target, action: 'edit', text: 'changed'});
            assert.equal(
                await backend.mutationState({...target, action: 'edit', text: 'changed'}),
                true,
            );
            assert.equal(
                await backend.mutationState({...target, action: 'edit', text: 'original'}),
                false,
            );
            assert.equal(await backend.mutationState({...target, action: 'delete'}), false);
            assert.equal(
                await backend.mutationState({
                    ...target,
                    messageId: 'm:0200000000000000',
                    action: 'delete',
                }),
                false,
            );
            await assert.rejects(
                backend.mutationState({...target, profile: 'OTHER123', action: 'delete'}),
                {code: 'mutation-permission-denied'},
            );
        } finally {
            await backend.stop();
        }
    }
});
