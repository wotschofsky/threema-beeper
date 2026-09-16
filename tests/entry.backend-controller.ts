import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {BackendController} from '../src/threema/backend-controller.ts';
import {openSavedProfile} from '../src/threema/saved-profile.ts';
import {generateProfileSecret, saveProfileSecret} from '../src/setup/profile-secret.ts';

await test(
    'dedicated backend worker opens only its configured profile and terminates cleanly',
    {timeout: 15000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-worker-session-'));
        const worker = new BackendController({
            profileDirectory: directory,
            wasmFile: resolve('.local/wasm-web/libthreema_bg.wasm'),
        });
        try {
            await worker.ready;
            assert.deepEqual(await worker.mediaLimits(), {maximumBytes: 100 * 1024 * 1024});
            let allocations = 0;
            await assert.rejects(
                worker.sendText(
                    {profile: 'SELF1234', chatId: 'c:TEST1234', text: 'offline fixture'},
                    async () => {
                        allocations++;
                    },
                ),
                {code: 'backend-operation-failed'},
            );
            assert.equal(allocations, 0);
            await assert.rejects(
                worker.mutationState({
                    profile: 'SELF1234',
                    chatId: 'c:TEST1234',
                    messageId: 'm:0100000000000000',
                    action: 'delete',
                }),
                {code: 'backend-operation-failed'},
            );
            await assert.rejects(
                worker.mutateMessage({
                    profile: 'SELF1234',
                    chatId: 'c:TEST1234',
                    messageId: 'm:0100000000000000',
                    action: 'edit',
                    text: 'synthetic',
                }),
                {code: 'backend-operation-failed'},
            );
            await assert.rejects(
                worker.mutateMessage({
                    profile: 'SELF1234',
                    chatId: 'c:TEST1234',
                    messageId: 'm:0100000000000000',
                    action: 'delete',
                }),
                {code: 'backend-operation-failed'},
            );

            const mediaRequest = {
                chatId: 'c:TEST1234',
                messageId: 'm:0100000000000000',
                part: 'file' as const,
                maximumBytes: 100,
            };
            await assert.rejects(worker.mediaInfo(mediaRequest), {
                code: 'backend-operation-failed',
            });
            await assert.rejects(
                worker.mediaStream(mediaRequest, {
                    bytes: 0,
                    sha256: '0'.repeat(64),
                    mimeType: 'application/octet-stream',
                }),
                {code: 'backend-operation-failed'},
            );
            await assert.rejects(worker.identity(), {code: 'backend-operation-failed'});
            await assert.rejects(worker.conversations(), {code: 'backend-operation-failed'});
            await assert.rejects(worker.directory(), {code: 'backend-operation-failed'});
            await assert.rejects(
                worker.watchTopology(() => undefined),
                {code: 'backend-operation-failed'},
            );
            await assert.rejects(worker.history('c:TEST1234'), {code: 'backend-operation-failed'});
            await assert.rejects(
                worker.watchMessages(
                    'c:TEST1234',
                    async () => undefined,
                    () => undefined,
                ),
                {code: 'backend-operation-failed'},
            );
            await assert.rejects(worker.providePassword('synthetic-wrong-state-password'), {
                code: 'backend-operation-failed',
            });
            await assert.rejects(worker.open('synthetic-unused-secret'), {code: 'no-identity'});
            await worker.stop();
            await worker.stop();
            await assert.rejects(worker.open('synthetic'), {code: 'backend-worker-stopped'});
        } finally {
            await worker.stop();
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'saved-profile open never relinks a missing identity and releases the profile on failure',
    {timeout: 15000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-saved-open-'));
        const secretFile = join(directory, 'secret');
        const options = {
            profileDirectory: directory,
            secretFile,
            wasmFile: resolve('.local/wasm-web/libthreema_bg.wasm'),
        };
        try {
            saveProfileSecret(secretFile, generateProfileSecret());
            await assert.rejects(openSavedProfile(options), {code: 'no-identity'});
            // A second owner can initialize only if the failed open released its worker lock.
            const replacement = new BackendController(options);
            try {
                await replacement.ready;
            } finally {
                await replacement.stop();
            }
        } finally {
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'cancelling worker startup rejects pending work without leaving a worker behind',
    {timeout: 15000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-worker-cancel-'));
        const worker = new BackendController({
            profileDirectory: directory,
            wasmFile: resolve('.local/wasm-web/libthreema_bg.wasm'),
        });
        const opening = worker.open('synthetic-unused-secret');
        const rejected = assert.rejects(opening, {code: 'backend-worker-stopped'});
        try {
            await worker.stop();
            await rejected;
        } finally {
            await worker.stop();
            rmSync(directory, {recursive: true, force: true});
        }
    },
);

await test(
    'two backend workers cannot share a profile and termination releases ownership',
    {timeout: 15000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-worker-owner-'));
        const options = {
            profileDirectory: directory,
            wasmFile: resolve('.local/wasm-web/libthreema_bg.wasm'),
        };
        const workers: BackendController[] = [];
        try {
            const first = new BackendController(options);
            workers.push(first);
            await first.ready;
            const second = new BackendController(options);
            workers.push(second);
            await assert.rejects(second.ready, {code: 'profile-in-use'});
            await second.stop();
            await first.stop();
            const replacement = new BackendController(options);
            workers.push(replacement);
            await replacement.ready;
        } finally {
            await Promise.all(workers.map((worker) => worker.stop()));
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
