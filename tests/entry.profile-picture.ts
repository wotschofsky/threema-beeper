import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {isMainThread, parentPort, Worker} from 'node:worker_threads';
import {BackendController} from '../src/threema/backend-controller.ts';
import {serveBackendSession, type BackendSession} from '../src/threema/backend-session-router.ts';
import {parseProfilePicture} from '../src/threema/profile-picture.ts';

if (!isMainThread) {
    serveBackendSession(
        parentPort!,
        {
            profilePicture: async (id: string) =>
                id === 'TEST1234'
                    ? new Uint8Array([255, 216, 255, 224])
                    : id === 'BIGPIC01'
                      ? new Uint8Array(2 * 1024 * 1024 + 1)
                      : null,
        } as BackendSession,
        () => ({maximumBytes: 1024}),
    );
} else {
    await test('contact pictures cross the real worker route as bounded bytes without contact lookup', async () => {
        const backend = new BackendController(
            {profileDirectory: '/synthetic', wasmFile: '/synthetic'},
            (_entry, options) => new Worker(new URL(import.meta.url), {...options}),
        );
        try {
            await backend.ready;
            assert.deepEqual(
                await backend.profilePicture('TEST1234'),
                new Uint8Array([255, 216, 255, 224]),
            );
            assert.equal(await backend.profilePicture('*NONE123'), null);
            await assert.rejects(backend.profilePicture('invalid'), /identity/);
            await assert.rejects(backend.profilePicture('BIGPIC01'), {
                code: 'backend-operation-failed',
            });
            assert.throws(() => parseProfilePicture({privateKey: 'never a picture'}));
            assert.throws(() => parseProfilePicture(new Uint8Array()));
        } finally {
            await backend.stop();
        }
    });
    await test('native picture read copies an existing model and never creates a contact', async () => {
        const native = createRequire(import.meta.url)(
            '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
        );
        let picture: Uint8Array | undefined = new Uint8Array([255, 216, 255, 224]);
        let lookups = 0;
        const handle = {
            model: {
                contacts: {
                    getByIdentity: (id: string) => {
                        lookups++;
                        return id === 'TEST1234'
                            ? {
                                  get: () => ({
                                      controller: {
                                          profilePicture: {get: () => ({view: {picture}})},
                                      },
                                  }),
                              }
                            : undefined;
                    },
                },
            },
        };
        const result = await native.readNodeProfilePicture(handle, 'TEST1234');
        assert.deepEqual(result, picture);
        result[0] = 0;
        assert.equal(picture[0], 255);
        assert.equal(await native.readNodeProfilePicture(handle, '*NONE123'), null);
        picture = undefined;
        assert.equal(await native.readNodeProfilePicture(handle, 'TEST1234'), null);
        await assert.rejects(native.readNodeProfilePicture(handle, 'bad'), /identity/);
        assert.equal(lookups, 3);
        picture = new Uint8Array(2 * 1024 * 1024 + 1);
        await assert.rejects(native.readNodeProfilePicture(handle, 'TEST1234'), /limits/);
        picture = new Uint8Array([255, 216, 255, 224]);
        Object.assign(handle.model, {
            user: {identity: 'SELF1234'},
            groups: {
                getAll: async () => ({
                    get: () =>
                        new Set([
                            {
                                get: () => ({
                                    type: 2,
                                    view: {creator: 'me', groupId: 1n},
                                    controller: {profilePicture: {get: () => ({view: {picture}})}},
                                }),
                            },
                        ]),
                }),
            },
        });
        const group = await native.readNodeProfilePicture(handle, 'g:SELF1234:0100000000000000');
        assert.deepEqual(group, picture);
        group[0] = 0;
        assert.equal(picture[0], 255);
        assert.equal(
            await native.readNodeProfilePicture(handle, 'g:OTHER123:0100000000000000'),
            null,
        );
    });
}
