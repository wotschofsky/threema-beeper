import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require = createRequire(import.meta.url);
const {
    ensureNodeContact,
} = require('../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs');

await test('compiled upstream contact resolver handles promotion, creation races and invalid IDs', async () => {
    for (const kind of ['exists-direct', 'exists-in-group', 'new', 'invalid', 'me']) {
        let created = 0,
            promoted = 0,
            lookedUp = 0;
        const view = {
            identity: 'ABCD1234',
            firstName: 'First',
            lastName: 'Last',
            displayName: 'Name',
            verificationLevel: 0,
            activityState: 0,
        };
        const store = {get: () => ({view})};
        const controller = {
            lookupContact: async (ids: Set<string>) => {
                lookedUp++;
                assert.deepEqual([...ids], ['ABCD1234']);
                return [{type: kind, uid: 1n, contactInit: {synthetic: true}}];
            },
            createContact: async () => {
                created++;
                return 'race';
            },
            updateAcquaintanceLevelAndName: async (uid: bigint, names: unknown) => {
                promoted++;
                assert.equal(uid, 1n);
                assert.deepEqual(names, {firstName: 'First', lastName: 'Last'});
            },
        };
        const handle = {
            viewModel: {receiverList: async () => ({viewModelController: controller})},
            model: {
                user: {
                    identity: 'SELF1234',
                    privacySettings: {
                        get: () => ({controller: {isContactBlocked: async () => false}}),
                    },
                },
                contacts: {getByUid: async () => store, getAll: async () => ({get: () => [store]})},
                groups: {getAll: async () => ({get: () => []})},
            },
        };
        await assert.rejects(ensureNodeContact(handle, 'ßabcd123'));
        assert.equal(lookedUp, 0);
        if (kind === 'invalid' || kind === 'me')
            await assert.rejects(ensureNodeContact(handle, 'abcd1234'), {
                type: kind === 'invalid' ? 'contact-unavailable' : 'contact-is-self',
            });
        else {
            const result = await ensureNodeContact(handle, 'abcd1234');
            assert.equal(result.identity, 'ABCD1234');
            assert.deepEqual(
                Object.keys(result).sort(),
                [
                    'identity',
                    'firstName',
                    'lastName',
                    'displayName',
                    'verification',
                    'activity',
                    'blocked',
                ].sort(),
            );
        }
        assert.equal(created, kind === 'new' ? 1 : 0);
        assert.equal(promoted, kind === 'exists-in-group' ? 1 : 0);
    }
});
