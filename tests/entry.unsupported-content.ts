import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {unsupportedContent} from '../src/matrix/unsupported-content.ts';
import {unsupportedReason} from '../src/outbox/unsupported-notices.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import type {InboxEvent} from '../src/matrix/transaction-inbox.ts';
const native = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
await test('unsupported polls and payloads explain phone fallback; native locations retain usable coordinates', () => {
    for (const type of ['poll', 'unsupported']) {
        const content = unsupportedContent({content: {type}} as NormalizedNodeMessage)!;
        assert.equal(content.msgtype, 'm.notice');
        assert.match(content.body as string, /Open Threema on your phone/);
    }
    assert.equal(
        unsupportedContent({content: {type: 'text', text: 'normal'}} as NormalizedNodeMessage),
        undefined,
    );
    const location = native.ProbeLocationText({
        coordinates: {lat: 47, lon: 8},
        name: 'Synthetic fixture',
    });
    assert.match(location, /Location messages are not supported in Beeper/);
    assert.match(location, /Open Threema on your phone/);
    assert.match(location, /mlat=47&mlon=8/);
    for (const [type, content] of [
        ['m.call.invite', {}],
        ['m.poll.start', {}],
        ['m.room.message', {msgtype: 'm.location'}],
    ] as const)
        assert.match(
            unsupportedReason({type, content} as InboxEvent)!,
            /Open Threema on your phone/,
        );
});
