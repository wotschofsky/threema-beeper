import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MediaTransfer} from '../src/media/media-transfer.ts';
import {MediaRenderer} from '../src/media/media-renderer.ts';
import {MessageDelivery} from '../src/matrix/message-delivery.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('media projection retains encrypted files, thumbnails and edits without repeated upload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-render-'));
    const key = randomBytes(32);
    const store = new PortalStore(join(directory, 'store.sqlite'), key);
    const data = Buffer.from('synthetic file data'),
        thumbnail = Buffer.from('synthetic thumbnail');
    const client = new MatrixClient('https://matrix.invalid', 'synthetic');
    let uploads = 0,
        opens = 0;
    client.doRequest = async (_method, path, _query, stream): Promise<any> => {
        assert.equal(path, '/_matrix/media/v3/upload');
        assert.ok(stream instanceof Readable);
        for await (const _chunk of stream) {
            /* Consume ciphertext using backpressure. */
        }
        return {content_uri: `mxc://matrix.invalid/file${++uploads}`};
    };
    const renderer = new MediaRenderer({
        profile: 'SELF1234',
        transfer: new MediaTransfer(store, directory),
        client,
        maxBytes: async () => 1000,
        verifyMime: async () => {},
        describe: async (message, part) => {
            const content = message.content;
            assert.ok('mimeType' in content);
            const bytes = part === 'file' ? data : thumbnail;
            return {
                bytes: bytes.length,
                mimeType: part === 'file' ? content.mimeType : 'image/png',
                sha256: createHash('sha256').update(bytes).digest('hex'),
                open: async () => {
                    opens++;
                    return Readable.from([bytes]);
                },
            };
        },
    });
    const message: NormalizedNodeMessage = {
        chatId: 'c:TEST1234',
        messageId: 'm:0100000000000000',
        direction: 'inbound',
        senderIdentity: 'TEST1234',
        createdAt: new Date(1234),
        ordinal: 1n,
        reactions: [],
        content: {
            type: 'video',
            mimeType: 'video/mp4',
            byteSize: data.length,
            fileName: 'Clip.mp4',
            caption: 'Caption',
            dimensions: {width: 640, height: 480},
            durationSeconds: 1.25,
            thumbnailRef: 'b:00112233',
            thumbnailMimeType: 'image/png',
        },
    };
    const events: Record<string, any>[] = [];
    const sender = {
        send: async (id: string, room: string, _type: string, content: Record<string, unknown>) => {
            const event = `$event${events.length}`;
            events.push(content);
            store.prepareOperation({
                id,
                sender: '@ghost:matrix.invalid',
                room,
                digest: id,
                ciphertext: 'synthetic',
            });
            store.completeOperation(id, event);
            return event;
        },
    };
    try {
        store.bind('SELF1234', message.chatId, '!room:matrix.invalid');
        const delivery = new MessageDelivery(store, (value) => renderer.render(value));
        await delivery.deliver(
            'SELF1234',
            '!room:matrix.invalid',
            '@ghost:matrix.invalid',
            sender,
            message,
            'first',
        );
        assert.equal(uploads, 2);
        assert.equal(opens, 2);
        const event = events[0]!;
        assert.equal(event.msgtype, 'm.video');
        assert.equal(event.body, 'Caption');
        assert.equal(event.filename, 'Clip.mp4');
        assert.equal(event.url, undefined);
        assert.equal(event.info.thumbnail_url, undefined);
        assert.equal(event.info.duration, 1250);
        assert.equal(event.info.w, 640);
        assert.equal(event.info.h, 480);
        assert.equal(event.file.v, 'v2');
        assert.equal(event.info.thumbnail_file.v, 'v2');
        assert.notEqual(event.file.key.k, event.info.thumbnail_file.key.k);
        await delivery.deliver(
            'SELF1234',
            '!room:matrix.invalid',
            '@ghost:matrix.invalid',
            sender,
            {
                ...message,
                content: {
                    ...(message.content as Extract<
                        NormalizedNodeMessage['content'],
                        {type: 'video' | 'image' | 'audio' | 'file'}
                    >),
                    caption: 'Changed',
                },
            },
            'edit',
        );
        assert.equal(uploads, 2);
        assert.equal(opens, 2);
        assert.deepEqual(events[1]!['m.relates_to'], {rel_type: 'm.replace', event_id: '$event0'});
        assert.equal(events[1]!['m.new_content'].body, 'Changed');
        assert.equal(events[1]!['m.new_content'].file.url, event.file.url);
        for (const [type, mimeType] of [
            ['image', 'image/png'],
            ['audio', 'audio/ogg'],
            ['file', 'application/octet-stream'],
        ] as const) {
            const rendered = await renderer.render({
                ...message,
                content: {type, mimeType, byteSize: data.length, fileName: 'original.bin'},
            });
            assert.equal(rendered.msgtype, `m.${type}`);
            assert.equal(rendered.body, 'original.bin');
            assert.equal(rendered.url, undefined);
        }
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
