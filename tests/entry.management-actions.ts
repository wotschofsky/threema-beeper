import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ManagementActions} from '../src/management/actions.ts';

await test('management actions expose bounded selected fields and preserve resolver event identity', async () => {
    let resyncs = 0;
    const pm: string[][] = [];
    const options = {
        status: () => ({ready: false, secret: 'DO-NOT-DISCLOSE'}),
        directory: async () => ({
            groups: [],
            contacts: Array.from({length: 150}, (_, index) => ({
                identity: `ID${String(index).padStart(6, '0')}`,
                displayName: 'Name\n\u202e😀'.repeat(500),
                firstName: 'DO-NOT-DISCLOSE',
                lastName: '',
                verification: 0,
                activity: 0,
                blocked: index === 0,
            })),
        }),
        resync: () => {
            resyncs++;
            return true;
        },
        doctor: async () => ({
            checks: [
                {status: 'pass' as const, detail: '/private/DO-NOT-DISCLOSE'},
                {status: 'unknown' as const},
                {status: 'fail' as const},
            ],
            secret: 'DO-NOT-DISCLOSE',
        }),
        version: async () => ({source: {sha256: 'a'.repeat(64), files: ['DO-NOT-DISCLOSE']}}),
        pm: async (identity: string, id: string) => {
            pm.push([identity, id]);
            return '!dm:invalid';
        },
    };
    const actions = new ManagementActions(options);
    const mediaActions = new ManagementActions({
        ...options,
        status: () => ({
            ready: true,
            mediaQueues: {
                prepared: 2,
                dispatching: 1,
                awaitingEcho: 3,
                uncertain: 4,
                private: 'DO-NOT-DISCLOSE',
            },
        }),
    });
    const mediaStatus = await mediaActions.execute({kind: 'status'}, '$status');
    assert(
        String(mediaStatus.body).includes(
            '2 queued, 1 sending, 3 awaiting confirmation, 4 uncertain',
        ),
    );
    assert(String(mediaStatus.body).includes('not retried automatically'));
    assert(!String(mediaStatus.body).includes('DO-NOT-DISCLOSE'));
    for (const kind of ['status', 'contacts', 'resync', 'doctor', 'version', 'help'] as const) {
        const output = await actions.execute({kind}, '$command');
        assert.equal(output.msgtype, 'm.notice');
        assert.equal(typeof output.body, 'string');
        const body = output.body as string;
        assert(!body.includes('DO-NOT-DISCLOSE'));
        assert(Buffer.byteLength(body) <= 65536);
        if (kind === 'contacts') {
            assert(body.includes('Showing 100 of 150'));
            assert(!body.includes('\u202e'));
            assert.equal(body.split('\n').length, 101);
            assert(body.includes('(blocked)'));
        }
        if (kind === 'doctor') assert(body.includes('1 passed, 1 failed, 1 unverified'));
    }
    assert.equal(resyncs, 1);
    const firstPage = await actions.execute({kind: 'contacts'}, '$first');
    assert.match(firstPage.body as string, /Next: contacts after ID000099$/);
    const nextPage = await actions.execute({kind: 'contacts', after: 'ID000099'}, '$next');
    assert.match(nextPage.body as string, /^ID000100/);
    assert.match(nextPage.body as string, /Showing 50 of 150 contacts\.$/);
    assert(!(nextPage.body as string).includes('ID000099'));
    const exhausted = await actions.execute({kind: 'contacts', after: 'ID000149'}, '$end');
    assert.equal(exhausted.body, 'No more contacts after this ID.');
    await assert.rejects(actions.execute({kind: 'contacts', after: 'invalid'}, '$badcursor'));
    // Removing the cursor contact must not shift the next page or require it to still exist.
    const directory = await options.directory();
    const changed = new ManagementActions({
        ...options,
        directory: async () => ({
            groups: [],
            contacts: directory.contacts.filter((contact) => contact.identity !== 'ID000099'),
        }),
    });
    const resumed = await changed.execute({kind: 'contacts', after: 'ID000099'}, '$resumed');
    assert.match(resumed.body as string, /^ID000100/);
    const result = await actions.execute({kind: 'pm', identity: 'ABCD1234'}, '$pm');
    assert.deepEqual(pm, [['ABCD1234', '$pm']]);
    assert.equal(result.body, 'Chat ready: https://matrix.to/#/!dm%3Ainvalid');
    await assert.rejects(
        new ManagementActions({
            ...options,
            pm: async () => {
                throw new Error('unavailable');
            },
        }).execute({kind: 'pm', identity: 'ABCD1234'}, '$failed'),
    );
    await assert.rejects(
        new ManagementActions({
            ...options,
            version: async () => ({source: {sha256: 'unsafe'}}),
        }).execute({kind: 'version'}, '$bad'),
    );
});
