import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {BackendController} from '../src/threema/backend-controller.ts';
import {parsePrepareFile, prepareFileFromPort} from '../src/threema/prepare-file-command.ts';
const request = {profile: 'SELF1234', chatId: 'c:ABCD1234', bytes: 200000};
await test('controller and worker preparation stream bounded packets and expose only a token', async () => {
    const parts: Buffer[] = [];
    const token = 'a'.repeat(64);
    const context = {
        preparationStreams: new Set<Readable>(),
        request: async (command: string, password: unknown, data: unknown, ports: unknown[]) => {
            assert.equal(command, 'prepare-file');
            assert.equal(password, undefined);
            assert.equal(ports.length, 1);
            return prepareFileFromPort(
                {
                    prepareFile: async (received, source) => {
                        assert.deepEqual(received, request);
                        for await (const part of source) {
                            assert.ok(part.length <= 65536);
                            parts.push(Buffer.from(part));
                        }
                        return token;
                    },
                },
                data,
            );
        },
    };
    const source = Readable.from([Buffer.alloc(request.bytes, 7)]);
    assert.equal(
        await BackendController.prototype.prepareFile.call(context as any, request, source),
        token,
    );
    assert.deepEqual(Buffer.concat(parts), Buffer.alloc(request.bytes, 7));
    assert.equal(source.destroyed, true);
    assert.throws(() => parsePrepareFile({...request, key: 'not-allowed'}));
    assert.throws(() => parsePrepareFile({...request, bytes: -1}));
});
await test('source failure and cancellation during authorization reject preparation without leaking port errors', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
    });
    const context = {
        preparationStreams: new Set<Readable>(),
        request: async (_command: string, _password: unknown, data: unknown) =>
            prepareFileFromPort(
                {
                    prepareFile: async (_received, source) => {
                        await gate;
                        for await (const _chunk of source) {
                        }
                        return 'a'.repeat(64);
                    },
                },
                data,
            ),
    };
    const abort = new AbortController();
    const source = Readable.from([Buffer.alloc(request.bytes)]);
    const result = BackendController.prototype.prepareFile.call(
        context as any,
        request,
        source,
        abort.signal,
    );
    const rejected = assert.rejects(result);
    abort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    unblock();
    await rejected;
    assert.equal(source.destroyed, true);
    const failed = Readable.from(
        (async function* () {
            yield Buffer.alloc(3);
            throw new Error('source failure');
        })(),
    );
    await assert.rejects(
        BackendController.prototype.prepareFile.call(context as any, request, failed),
    );
    assert.equal(failed.destroyed, true);
});

await test('discard IPC validates metadata and returns only a boolean', async () => {
    const request = {profile: 'SELF1234', chatId: 'c:ABCD1234', token: 'a'.repeat(64)};
    let calls = 0;
    const context = {
        request: async (command: string, password: unknown, data: unknown) => {
            calls++;
            assert.equal(command, 'discard-prepared-file');
            assert.equal(password, undefined);
            assert.deepEqual(data, request);
            return true;
        },
    };
    assert.equal(
        await BackendController.prototype.discardPreparedFile.call(context as any, request),
        true,
    );
    await assert.rejects(
        BackendController.prototype.discardPreparedFile.call(context as any, {
            ...request,
            token: 'invalid',
        }),
    );
    assert.equal(calls, 1);
});
