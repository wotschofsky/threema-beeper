import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {BackendController} from '../src/threema/backend-controller.ts';
function fixture(cleanup: () => Promise<unknown>) {
    let terminations = 0;
    const source = new Readable({read() {}});
    const context = Object.assign(Object.create(BackendController.prototype), {
        preparationStreams: new Set([source]),
        pending: new Map(),
        ready: Promise.resolve(),
        readyReject: () => {},
        stopped: false,
        draining: false,
        nextId: 1,
        worker: {
            terminate: async () => {
                terminations++;
            },
        },
        request: async (command: string) => {
            assert.equal(command, 'close-prepared-files');
            return cleanup();
        },
    });
    return {context, source, terminations: () => terminations};
}
await test('normal stop cancels preparation and waits for cleanup before terminating exactly once', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const {context, source, terminations} = fixture(() => wait);
    const first = context.stop(),
        second = context.stop();
    assert.equal(source.destroyed, true);
    assert.equal(context.draining, true);
    assert.equal(terminations(), 0);
    await assert.rejects(
        (BackendController.prototype as any).request.call(context, 'identity'),
        /stopped/,
    );
    release();
    await Promise.all([first, second]);
    assert.equal(terminations(), 1);
    await context.stop();
    assert.equal(terminations(), 1);
});
await test('cleanup failure or timeout still terminates the backend', async () => {
    const failed = fixture(async () => {
        throw new Error('cleanup failed');
    });
    await failed.context.stop();
    assert.equal(failed.terminations(), 1);
    const stalled = fixture(() => new Promise(() => {}));
    const start = Date.now();
    await stalled.context.stop();
    assert.equal(stalled.terminations(), 1);
    assert.ok(Date.now() - start >= 1900);
});
