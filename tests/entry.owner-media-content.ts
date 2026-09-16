import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {createOwnerMediaRenderer} from '../src/matrix/owner-media-content.ts';
import type {InboxEvent} from '../src/matrix/transaction-inbox.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('owner caption rendering preserves original attachment descriptors and requires verified ownership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-media-')),
        key = randomBytes(32);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:TEST1234';
    const message: NormalizedNodeMessage = {
        direction: 'outbound',
        senderIdentity: profile,
        chatId: chat,
        messageId: 'm:0100000000000000',
        createdAt: new Date(1000),
        ordinal: 1n,
        reactions: [],
        content: {
            type: 'image',
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            byteSize: 100,
            caption: 'phone caption',
        },
    };
    const event: InboxEvent = {
        event_id: '$original',
        room_id: room,
        sender: owner,
        type: 'm.room.message',
        encrypted: true,
        content: {
            'msgtype': 'm.image',
            'filename': 'photo.jpg',
            'body': 'old caption',
            'format': 'org.matrix.custom.html',
            'formatted_body': '<b>old caption</b>',
            'file': {
                url: 'mxc://invalid/original',
                key: {k: 'synthetic'},
                iv: 'synthetic',
                hashes: {sha256: 'synthetic'},
                v: 'v2',
            },
            'info': {
                w: 500,
                h: 400,
                mimetype: 'image/jpeg',
                thumbnail_file: {url: 'mxc://invalid/thumb'},
            },
            'm.relates_to': {'m.in_reply_to': {event_id: '$reply'}},
        },
    };
    let returned: InboxEvent | undefined = event;
    let lookups = 0;
    const render = createOwnerMediaRenderer({
        profile,
        owner,
        portals,
        original: async (id, target) => {
            lookups++;
            assert.equal(id, '$original');
            assert.equal(target, room);
            return returned;
        },
    });
    try {
        portals.bind(profile, chat, room);
        portals.bindOwnerEcho({
            profile,
            chat,
            message: message.messageId,
            room,
            sender: owner,
            root: '$original',
            latest: '$original',
            digest: 'synthetic',
        });
        const result = await render(message);
        assert.equal(result.body, 'phone caption');
        assert.deepEqual(result.file, event.content.file);
        assert.deepEqual(result.info, event.content.info);
        assert.deepEqual(result['m.relates_to'], event.content['m.relates_to']);
        assert.equal(result.formatted_body, undefined);
        assert.equal(event.content.body, 'old caption');
        assert.equal(message.content.type, 'image');
        if (message.content.type !== 'image') assert.fail('Expected image fixture');
        message.content = {...message.content, caption: ''};
        assert.equal((await render(message)).body, 'photo.jpg');
        returned = {...event, sender: '@foreign:invalid'};
        await assert.rejects(render(message), /Verified owner/);
        returned = undefined;
        await assert.rejects(render(message), /Verified owner/);
        const before = lookups;
        await assert.rejects(render({...message, direction: 'inbound'}), /Unsupported owner/);
        assert.equal(lookups, before);
    } finally {
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
