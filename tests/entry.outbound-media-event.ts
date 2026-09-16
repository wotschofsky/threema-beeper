import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {InboxEvent} from '../src/matrix/transaction-inbox.ts';
import {resolveOutboundMedia} from '../src/media/outbound-event.ts';

const profile = 'SELF1234',
    owner = '@owner:invalid',
    room = '!room:invalid';
const options = {
    profile,
    owner,
    maximumBytes: 1000,
    portals: {
        portalForRoom: (id: string) => (id === room ? {profile, chat: 'c:ABCD1234'} : undefined),
    },
};
const event: InboxEvent = {
    event_id: '$media',
    room_id: room,
    sender: owner,
    encrypted: true,
    type: 'm.room.message',
    content: {
        msgtype: 'm.image',
        body: 'A caption',
        filename: 'photo.png',
        info: {mimetype: 'image/png', size: 100},
        file: {
            url: 'mxc://media.invalid/opaque-id',
            v: 'v2',
            key: {
                kty: 'oct',
                alg: 'A256CTR',
                key_ops: ['encrypt', 'decrypt'],
                k: Buffer.alloc(32, 1).toString('base64url'),
            },
            iv: Buffer.alloc(16, 2).toString('base64'),
            hashes: {sha256: Buffer.alloc(32, 3).toString('base64')},
        },
    },
};
await test('owner encrypted media classification preserves captions, limits and immutable descriptors', () => {
    for (const msgtype of ['m.file', 'm.image', 'm.video', 'm.audio']) {
        const source = structuredClone(event);
        source.content.msgtype = msgtype;
        const result = resolveOutboundMedia(source, options);
        assert.equal(result.kind, 'resolved');
        if (result.kind !== 'resolved') assert.fail();
        assert.equal(result.media.kind, msgtype);
        assert.equal(result.media.caption, 'A caption');
        assert.equal(result.media.filename, 'photo.png');
        assert.equal(result.media.bytes, 100);
        (source.content.file as any).key.k = 'changed';
        assert.equal(result.media.file.key.k, Buffer.alloc(32, 1).toString('base64url'));
    }
    const reply = structuredClone(event);
    reply.content['m.relates_to'] = {'m.in_reply_to': {event_id: '$original'}};
    delete (reply.content.info as any).size;
    const result = resolveOutboundMedia(reply, options);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
        assert.equal(result.media.replyTo, '$original');
        assert.equal(result.media.bytes, undefined);
    }
});
await test('untrusted media cannot bypass sender, room, encryption, descriptor or size validation', () => {
    assert.equal(
        resolveOutboundMedia({...event, sender: '@other:invalid'}, options).kind,
        'ignore',
    );
    assert.equal(
        resolveOutboundMedia({...event, room_id: '!other:invalid'}, options).kind,
        'ignore',
    );
    assert.equal(resolveOutboundMedia({...event, state_key: ''}, options).kind, 'ignore');
    const mutations: Array<(source: InboxEvent) => void> = [
        (s) => {
            s.encrypted = false;
        },
        (s) => {
            s.content.url = 'https://invalid/private';
        },
        (s) => {
            (s.content.file as any).url = 'https://invalid/private';
        },
        (s) => {
            (s.content.file as any).url = 'mxc://user:password@invalid/id';
        },
        (s) => {
            (s.content.file as any).url = 'mxc://invalid/id?query';
        },
        (s) => {
            (s.content.file as any).key.k = 'bad';
        },
        (s) => {
            (s.content.file as any).hashes.sha256 = 'bad';
        },
        (s) => {
            (s.content.file as any).key.key_ops = ['encrypt'];
        },
        (s) => {
            (s.content.info as any).size = 1001;
        },
        (s) => {
            (s.content.info as any).size = -1;
        },
        (s) => {
            (s.content.info as any).size = NaN;
        },
        (s) => {
            (s.content.info as any).mimetype = 'image/png\nheader';
        },
        (s) => {
            s.content.filename = '../private';
        },
        (s) => {
            s.content['m.relates_to'] = {rel_type: 'm.replace', event_id: '$original'};
        },
    ];
    for (const mutate of mutations) {
        const source = structuredClone(event);
        mutate(source);
        assert.equal(resolveOutboundMedia(source, options).kind, 'rejected');
    }
});

await test('Beeper duplicate encrypted URL is accepted but conflicting locations remain rejected', () => {
    const source = structuredClone(event);
    source.content.url = (source.content.file as {url: string}).url;
    assert.equal(resolveOutboundMedia(source, options).kind, 'resolved');
    source.content.url = 'mxc://media.invalid/different';
    assert.equal(resolveOutboundMedia(source, options).kind, 'rejected');
});
