import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {parseDirectory} from '../src/threema/directory.ts';
const {readNodeDirectory} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {readNodeDirectory(handle: unknown): Promise<unknown>};
const store = <T>(value: T) => ({get: () => value});
await test('directory normalizes blocking and group membership using upstream conventions', async () => {
    const contact = store({
        view: {
            identity: 'TEST1234',
            firstName: 'Test',
            lastName: 'Contact',
            displayName: 'Test Contact',
            verificationLevel: 2,
            activityState: 0,
            publicKey: 'SECRET',
        },
    });
    const asked: string[] = [];
    const handle = {
        model: {
            user: {
                identity: 'SELF1234',
                privacySettings: store({
                    controller: {
                        isContactBlocked: async (id: string) => {
                            asked.push(id);
                            return true;
                        },
                    },
                }),
            },
            contacts: {getAll: async () => store(new Set([contact]))},
            groups: {
                getAll: async () =>
                    store(
                        new Set([
                            store({
                                view: {
                                    creator: 'me',
                                    groupId: 1n,
                                    name: 'Own group',
                                    members: new Set([contact]),
                                    userState: 0,
                                },
                            }),
                            store({
                                view: {
                                    creator: contact,
                                    groupId: 2n,
                                    name: 'Joined group',
                                    members: new Set(),
                                    userState: 0,
                                },
                            }),
                            store({
                                view: {
                                    creator: contact,
                                    groupId: 3n,
                                    name: 'Left group',
                                    members: new Set(),
                                    userState: 2,
                                },
                            }),
                        ]),
                    ),
            },
        },
    };
    const result = parseDirectory(await readNodeDirectory(handle));
    assert.deepEqual(asked, ['TEST1234']);
    assert.deepEqual(result.contacts, [
        {
            identity: 'TEST1234',
            firstName: 'Test',
            lastName: 'Contact',
            displayName: 'Test Contact',
            verification: 2,
            activity: 0,
            blocked: true,
        },
    ]);
    assert.deepEqual(
        result.groups.map((group) => group.memberIdentities),
        [['SELF1234', 'TEST1234'], ['SELF1234', 'TEST1234'], ['TEST1234']],
    );
    assert.equal(result.groups[0]!.groupKey, 'g:SELF1234:0100000000000000');
    assert.equal(result.groups[2]!.groupId, 3n);
});
await test('directory boundary rejects mismatched group keys, duplicate identities and private fields', () => {
    const contact = {
        identity: 'TEST1234',
        firstName: '',
        lastName: '',
        displayName: 'Test',
        verification: 0,
        activity: 0,
        blocked: false,
    };
    const group = {
        groupKey: 'g:TEST1234:0100000000000000',
        creatorIdentity: 'TEST1234',
        groupId: 1n,
        name: 'Group',
        memberIdentities: ['TEST1234'],
        userState: 0,
    };
    assert.throws(() => parseDirectory({contacts: [contact, contact], groups: []}));
    assert.throws(() =>
        parseDirectory({contacts: [{...contact, publicKey: 'secret'}], groups: []}),
    );
    assert.throws(() => parseDirectory({contacts: [], groups: [{...group, groupId: 2n}]}));
    assert.throws(() =>
        parseDirectory({
            contacts: [],
            groups: [{...group, memberIdentities: ['TEST1234', 'TEST1234']}],
        }),
    );
    assert.throws(() => parseDirectory({contacts: [], groups: [{...group, userState: 99}]}));
});
