/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Synchronous subscriber callbacks can change active during subscribe and enumeration. */
import {DeltaUpdateType} from '~/common/enum';
import type {ISubscribableStore, StoreUnsubscriber} from '~/common/utils/store';
import type {DeltaUpdate} from '~/common/utils/store/set-store';

/** Observe the collection before its snapshot and every inner model, including in-place edits. */
export function watchNodeModels<T, S extends ISubscribableStore<T>>(
    source: {
        get: () => ReadonlySet<S>;
        subscribe: (listener: (value: ReadonlySet<S>) => void) => StoreUnsubscriber;
        delta: {subscribe: (listener: (event: DeltaUpdate<S>) => void) => StoreUnsubscriber};
    },
    callbacks: {
        upsert: (store: S, value: T) => void;
        remove: (store: S) => void;
        reset: () => void;
        failed: () => void;
    },
    options: {emitSnapshot?: boolean} = {},
): StoreUnsubscriber {
    let active = true;
    let outer: StoreUnsubscriber | undefined;
    let retainCollection: StoreUnsubscriber | undefined;
    const inner = new Map<S, {close?: StoreUnsubscriber}>();
    function stop(): void {
        if (!active) {
            return;
        }
        active = false;
        outer?.();
        outer = undefined;
        retainCollection?.();
        retainCollection = undefined;
        for (const item of inner.values()) {
            item.close?.();
        }
        inner.clear();
    }
    function guarded(run: () => void): void {
        if (!active) {
            return;
        }
        try {
            run();
        } catch {
            stop();
            reportFailure();
        }
    }
    function reportFailure(): void {
        try {
            callbacks.failed();
        } catch {
            // Reporting must not throw back into the upstream event dispatcher.
        }
    }
    function attach(store: S, emitInitial = true): void {
        if (!active || inner.has(store)) {
            return;
        }
        // Install ownership before subscribe(), which invokes its initial callback synchronously.
        const item: {close?: StoreUnsubscriber} = {};
        inner.set(store, item);
        let initial = true;
        item.close = store.subscribe((value) => {
            const skip = initial && !emitInitial;
            initial = false;
            if (skip) {
                return;
            }
            if (inner.get(store) === item) {
                guarded(() => callbacks.upsert(store, value));
            }
        });
        // The initial callback can remove this store or invalidate the whole watcher.
        if (!active || inner.get(store) !== item) {
            item.close();
        }
    }
    try {
        // Native model caches retain this collection weakly. Delta subscriptions retain only
        // its event controller, so also subscribe to the store to keep the collection alive.
        retainCollection = source.subscribe(() => undefined);
        outer = source.delta.subscribe(([type, values]) => {
            guarded(() => {
                switch (type) {
                    case DeltaUpdateType.ADDED:
                        for (const store of values) {
                            attach(store);
                        }
                        break;
                    case DeltaUpdateType.DELETED:
                        for (const store of values) {
                            const item = inner.get(store);
                            inner.delete(store);
                            item?.close?.();
                            callbacks.remove(store);
                        }
                        break;
                    case DeltaUpdateType.CLEARED:
                        stop();
                        callbacks.reset();
                        break;
                    default:
                        throw new Error('Unsupported collection delta');
                }
            });
        });
        if (!active) {
            outer();
        } else {
            // Snapshot copy protects iteration from synchronous mutations in upsert callbacks.
            for (const store of [...source.get()]) {
                if (!active) {
                    break;
                }
                if (source.get().has(store)) {
                    attach(store, options.emitSnapshot !== false);
                }
            }
        }
    } catch {
        stop();
        reportFailure();
    }
    return stop;
}
