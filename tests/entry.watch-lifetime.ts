import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';

if (process.argv.includes('--probe')) {
    const {ProbeSetStore, ProbeWritableStore, watchNodeModels} = createRequire(import.meta.url)(
        '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
    );
    let seen = 0;
    function attach() {
        const collection = new ProbeSetStore(new Set());
        const stop = watchNodeModels(collection, {
            upsert: () => seen++,
            remove: () => undefined,
            reset: () => assert.fail('Unexpected reset'),
            failed: () => assert.fail('Unexpected failure'),
        });
        return {weak: new WeakRef(collection), stop};
    }
    const subscription = attach();
    const gc = (globalThis as unknown as {gc(): void}).gc;
    for (let i = 0; i < 10; i++) {
        await setImmediate();
        gc();
    }
    assert.ok(subscription.weak.deref(), 'Active watcher lost the weakly cached native collection');
    subscription.weak.deref()!.add(new ProbeWritableStore({text: 'synthetic'}));
    assert.equal(seen, 1, 'A new message must still reach the watcher after garbage collection');
    subscription.stop();
    for (let i = 0; i < 10; i++) {
        await setImmediate();
        gc();
    }
    assert.equal(
        subscription.weak.deref(),
        undefined,
        'Stopped watcher must release the collection',
    );
} else {
    await test('native message collection survives garbage collection while watched and is released on stop', () => {
        const result = spawnSync(
            process.execPath,
            ['--expose-gc', fileURLToPath(import.meta.url), '--probe'],
            {encoding: 'utf8', timeout: 15000},
        );
        assert.equal(result.status, 0, result.stderr || String(result.error));
    });
}
