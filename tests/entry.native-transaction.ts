import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
    EncryptionAlgorithm,
    OTKAlgorithm,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {
    processNativeTransaction,
    type NativeTransaction,
} from '../src/matrix/native-transaction.ts';

for (const mode of ['stable', 'legacy', 'both']) {
    const stable = mode !== 'legacy';
    await test(`native transaction applies ${mode} crypto updates before room decryption`, async () => {
        const user = '@bridge:example.invalid';
        const message: NonNullable<NativeTransaction['to_device']>[number] = {
            type: 'm.room.encrypted',
            sender: '@owner:example.invalid',
            content: {
                algorithm: EncryptionAlgorithm.OlmV1Curve25519AesSha2,
                sender_key: 'fixture-key',
                ciphertext: {},
            },
            to_user_id: user,
            to_device_id: 'DEVICE',
        };
        const calls: unknown[][] = [];
        const client = {
            crypto: {
                isReady: true,
                clientDeviceId: 'DEVICE',
                updateSyncData: async (...args: unknown[]) => {
                    calls.push(args);
                },
                decryptRoomEvent: async () => {
                    assert.equal(calls.length, 1, 'room keys must be processed before timeline');
                    return {raw: {type: 'm.room.message', content: {body: 'fixture'}}};
                },
            },
        };
        const fields = stable
            ? [
                  'to_device',
                  'device_lists',
                  'device_one_time_keys_count',
                  'device_unused_fallback_key_types',
              ]
            : [
                  'de.sorunome.msc2409.to_device',
                  'org.matrix.msc3202.device_lists',
                  'org.matrix.msc3202.device_one_time_keys_count',
                  'org.matrix.msc3202.device_unused_fallback_key_types',
              ];
        const transaction = {
            events: [
                {
                    type: 'm.room.encrypted',
                    sender: '@owner:example.invalid',
                    room_id: '!room:example.invalid',
                    event_id: '$event',
                    content: {},
                },
            ],
            [fields[0]!]: [message],
            [fields[1]!]: {changed: ['@owner:example.invalid'], removed: []},
            [fields[2]!]: {[user]: {DEVICE: {signed_curve25519: 42}}},
            [fields[3]!]: {[user]: {DEVICE: ['signed_curve25519']}},
        } as NativeTransaction;
        // Some proxies retain the old aliases alongside stable fields; never apply twice.
        if (mode === 'both') transaction['de.sorunome.msc2409.to_device'] = [message];
        let delivered = 0;
        await processNativeTransaction(
            transaction,
            new Map([[user, client as any]]),
            () => client as any,
            async () => {
                delivered++;
            },
        );
        assert.deepEqual(calls, [
            [
                [message],
                {signed_curve25519: 42},
                ['signed_curve25519'],
                ['@owner:example.invalid'],
                [],
            ],
        ]);
        assert.equal(delivered, 1);
    });
}

await test('key counts for inactive recipients do not block updates to an active crypto client', async () => {
    const active = '@bridge:example.invalid';
    const calls: unknown[][] = [];
    const client = {
        crypto: {
            isReady: true,
            clientDeviceId: 'ACTIVE',
            updateSyncData: async (...args: unknown[]) => {
                calls.push(args);
            },
        },
    };
    await processNativeTransaction(
        {
            events: [],
            device_one_time_keys_count: {
                [active]: {ACTIVE: {signed_curve25519: 42}},
                '@inactive_ghost:example.invalid': {OLD: {signed_curve25519: 50}},
            },
            device_unused_fallback_key_types: {
                '@inactive_ghost:example.invalid': {OLD: [OTKAlgorithm.Signed]},
            },
        },
        new Map([[active, client as any]]),
        () => assert.fail('must not create or route a room client'),
        async () => assert.fail('no timeline event'),
    );
    assert.deepEqual(calls, [[[], {signed_curve25519: 42}, [], [], []]]);
});

await test('Beeper key acknowledgements do not block encrypted key updates', async () => {
    let updates = 0;
    const user = '@bridge:example.invalid';
    const client = {
        crypto: {
            isReady: true,
            clientDeviceId: 'DEVICE',
            updateSyncData: async () => {
                updates++;
            },
        },
    };
    await processNativeTransaction(
        {
            events: [],
            to_device: [
                {
                    type: 'com.beeper.room_key.ack',
                    to_user_id: user,
                    to_device_id: 'DEVICE',
                    sender: '@owner:example.invalid',
                    content: {},
                } as any,
            ],
            device_one_time_keys_count: {[user]: {DEVICE: {signed_curve25519: 42}}},
        },
        new Map([[user, client as any]]),
        () => assert.fail(),
        async () => assert.fail(),
    );
    assert.equal(updates, 1);
});

await test('device-list updates accept omitted lists and the standard left field', async () => {
    const calls: unknown[][] = [];
    const client = {
        crypto: {
            isReady: true,
            clientDeviceId: 'DEVICE',
            updateSyncData: async (...args: unknown[]) => {
                calls.push(args);
            },
        },
    };
    const clients = new Map([['@bridge:example.invalid', client as any]]);
    await processNativeTransaction(
        {events: [], device_lists: {changed: ['@changed:example.invalid']} as any},
        clients,
        () => assert.fail(),
        async () => assert.fail(),
    );
    await processNativeTransaction(
        {events: [], device_lists: {left: ['@left:example.invalid']} as any},
        clients,
        () => assert.fail(),
        async () => assert.fail(),
    );
    assert.deepEqual(
        calls.map((c) => c.slice(3)),
        [
            [['@changed:example.invalid'], []],
            [[], ['@left:example.invalid']],
        ],
    );
});
