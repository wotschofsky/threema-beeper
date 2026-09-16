import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';

interface Store {
    get(): {text: string; reactions: string[]};
    set(value: {text: string; reactions: string[]}): void;
}
interface Collection {
    add(store: Store): void;
    delete(store: Store): void;
    clear(): void;
}
const {ProbeWritableStore, ProbeSetStore, watchNodeModels} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {
    ProbeWritableStore: new (value: ReturnType<Store['get']>) => Store;
    ProbeSetStore: new (value: Set<Store>) => Collection;
    watchNodeModels: (
        source: Collection,
        callbacks: {
            upsert(store: Store, value: ReturnType<Store['get']>): void;
            remove(store: Store): void;
            reset(): void;
            failed(): void;
        },
    ) => () => void;
};

await test('real upstream stores report inner edits/reactions, additions and removals independently', () => {
    const first = new ProbeWritableStore({text: 'original', reactions: []});
    const second = new ProbeWritableStore({text: 'second', reactions: []});
    const collection = new ProbeSetStore(new Set([first]));
    const changes: unknown[] = [];
    const removed: Store[] = [];
    let resets = 0;
    const stop = watchNodeModels(collection, {
        upsert: (_, value) => changes.push(structuredClone(value)),
        remove: (store) => removed.push(store),
        reset: () => {
            resets++;
        },
        failed: () => assert.fail('Watcher failed'),
    });
    try {
        first.set({text: 'edited', reactions: []});
        first.set({text: 'edited', reactions: ['👍']});
        collection.add(second);
        collection.delete(first);
        first.set({text: 'detached', reactions: []});
        assert.deepEqual(changes, [
            {text: 'original', reactions: []},
            {text: 'edited', reactions: []},
            {text: 'edited', reactions: ['👍']},
            {text: 'second', reactions: []},
        ]);
        assert.deepEqual(removed, [first]);
        collection.clear();
        assert.equal(resets, 1);
        second.set({text: 'must not emit', reactions: []});
        collection.add(first);
        assert.equal(changes.length, 4);
    } finally {
        stop();
        stop();
    }
});

await test('snapshot callback mutations do not miss new models or retain removed subscriptions', () => {
    const first = new ProbeWritableStore({text: 'first', reactions: []});
    const second = new ProbeWritableStore({text: 'second', reactions: []});
    const collection = new ProbeSetStore(new Set([first]));
    const observed: string[] = [];
    const stop = watchNodeModels(collection, {
        upsert: (store, value) => {
            observed.push(value.text);
            if (store === first) {
                collection.delete(first);
                collection.add(second);
            }
        },
        remove: () => undefined,
        reset: () => assert.fail('Unexpected reset'),
        failed: () => assert.fail('Unexpected failure'),
    });
    first.set({text: 'detached', reactions: []});
    second.set({text: 'updated', reactions: []});
    stop();
    second.set({text: 'closed', reactions: []});
    assert.deepEqual(observed, ['first', 'second', 'updated']);
});

await test('normalization failure stops all subscriptions and requires reconciliation', () => {
    const message = new ProbeWritableStore({text: 'message', reactions: []});
    const collection = new ProbeSetStore(new Set([message]));
    let failures = 0;
    let upserts = 0;
    const stop = watchNodeModels(collection, {
        upsert: () => {
            upserts++;
            throw new Error('synthetic normalization failure');
        },
        remove: () => assert.fail('Detached watcher emitted'),
        reset: () => assert.fail('Detached watcher emitted'),
        failed: () => {
            failures++;
        },
    });
    message.set({text: 'later', reactions: []});
    collection.clear();
    stop();
    assert.equal(failures, 1);
    assert.equal(upserts, 1);
});
