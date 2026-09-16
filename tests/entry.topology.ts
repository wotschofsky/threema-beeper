import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MessageChannel} from 'node:worker_threads';
import {test} from 'node:test';
import {receiveTopology, serveTopology} from '../src/threema/topology-subscription.ts';

interface Store {
    set(value: unknown): void;
}
interface Collection {
    add(value: Store): void;
    clear(): void;
}
const backend = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {
    ProbeWritableStore: new (value: unknown) => Store;
    ProbeSetStore: new (value: Set<Store>) => Collection;
    watchNodeTopology(handle: unknown, reset: () => void): Promise<() => Promise<void>>;
};
function fixture() {
    const contact = new backend.ProbeWritableStore({name: 'before'});
    const group = new backend.ProbeWritableStore({name: 'before'});
    const contacts = new backend.ProbeSetStore(new Set([contact]));
    const groups = new backend.ProbeSetStore(new Set([group]));
    const conversations = new backend.ProbeSetStore(new Set());
    const privacy = new backend.ProbeWritableStore({});
    return {
        contact,
        group,
        contacts,
        groups,
        conversations,
        privacy,
        handle: {
            model: {
                user: {privacySettings: privacy},
                conversations: {getAll: async () => conversations},
                contacts: {getAll: async () => contacts},
                groups: {getAll: async () => groups},
            },
        },
    };
}
await test('topology catches collection changes and inner contact/group updates once', async () => {
    for (const kind of ['contact', 'group', 'new-chat', 'clear', 'privacy']) {
        const f = fixture();
        let resets = 0;
        const stop = await backend.watchNodeTopology(f.handle, () => {
            resets++;
        });
        assert.equal(resets, 0, 'Initial model values must not trigger a reset');
        if (kind === 'contact') f.contact.set({name: 'after'});
        if (kind === 'group') f.group.set({name: 'after'});
        if (kind === 'new-chat') f.conversations.add(f.contact);
        if (kind === 'clear') f.contacts.clear();
        if (kind === 'privacy') f.privacy.set({blockUnknown: true});
        assert.equal(resets, 1);
        f.groups.clear();
        f.conversations.clear();
        f.contact.set({name: 'detached'});
        assert.equal(resets, 1, 'Invalidation must detach all listeners');
        await stop();
        await stop();
    }
});
await test(
    'topology invalidation crosses a dedicated port and orderly stop is silent',
    {timeout: 5000},
    async () => {
        for (const invalidate of [true, false]) {
            const channel = new MessageChannel();
            const f = fixture();
            let signal!: () => void;
            const reset = new Promise<void>((resolve) => {
                signal = resolve;
            });
            let resets = 0;
            const client = receiveTopology(channel.port1, () => {
                resets++;
                signal();
            });
            try {
                await serveTopology(channel.port2, (callback) =>
                    backend.watchNodeTopology(f.handle, callback),
                );
                if (invalidate) {
                    f.groups.clear();
                    await reset;
                }
                await client.stop();
                assert.equal(resets, invalidate ? 1 : 0);
                f.contacts.clear();
                assert.equal(resets, invalidate ? 1 : 0);
            } finally {
                client.dispose();
                channel.port2.close();
            }
        }
    },
);
