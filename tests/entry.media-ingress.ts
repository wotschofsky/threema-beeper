import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TransactionInbox, type InboxEvent} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {MediaIngress} from '../src/outbox/media-ingress.ts';
import {UnsupportedNoticeWorker} from '../src/outbox/unsupported-notices.ts';
import {sourceOrderPermits} from '../src/outbox/source-order.ts';

await test('file ingestion preserves source order and crash replay while notices own rejected attachments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'media-ingress-'));
    const key = randomBytes(32),
        profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid';
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const outbox = new OutboxStore(join(directory, 'outbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const options = {inbox, outbox, portals, profile, owner, maximumBytes: 1024};
    const event = (id: string, msgtype = 'm.file'): InboxEvent => ({
        event_id: id,
        room_id: room,
        sender: owner,
        type: 'm.room.message',
        encrypted: true,
        content: {
            msgtype,
            body: 'fixture.bin',
            info: {size: 3, mimetype: 'application/octet-stream'},
            file: {
                url: 'mxc://invalid/id',
                v: 'v2',
                key: {
                    kty: 'oct',
                    alg: 'A256CTR',
                    key_ops: ['decrypt'],
                    k: Buffer.alloc(32).toString('base64url'),
                },
                iv: Buffer.alloc(16).toString('base64'),
                hashes: {sha256: Buffer.alloc(32).toString('base64')},
            },
        },
    });
    const notices: string[] = [];
    const worker = new UnsupportedNoticeWorker({
        ...options,
        files: {maximumBytes: options.maximumBytes},
        ready: () => true,
        authorize: async () => {},
        send: async (_id, _room, content) => {
            notices.push(JSON.stringify(content));
        },
    });
    try {
        portals.bind(profile, 'c:ABCD1234', room);
        inbox.accept('older', {});
        inbox.accept('later', {});
        inbox.complete('later', [event('$later')]);
        let ingress = new MediaIngress(options);
        assert.equal(
            await worker.drain(),
            0,
            'notice worker must not reject a file waiting for ordering',
        );
        assert.throws(() => ingress.drain());
        assert.equal(outbox.media.get(profile, '$later'), undefined);
        inbox.complete('older', [event('$older')]);
        const acknowledge = inbox.acknowledgeEvent.bind(inbox);
        inbox.acknowledgeEvent = () => {
            throw new Error('synthetic crash');
        };
        assert.throws(() => ingress.drain());
        const firstId = outbox.media.get(profile, '$older')!.request.id;
        assert.equal(inbox.pendingEvents().length, 2);
        inbox.acknowledgeEvent = acknowledge;
        ingress = new MediaIngress(options);
        assert.equal(ingress.drain(), 2);
        assert.equal(outbox.media.get(profile, '$older')!.request.id, firstId);
        assert.equal(outbox.media.next(profile)!.request.event, '$older');
        assert.equal(sourceOrderPermits(inbox, outbox, profile, '$later', 'dispatch'), false);
        outbox.media.claim(profile, '$older');
        outbox.media.recordIds(profile, '$older', ['m:0100000000000000']);
        outbox.media.sent(profile, '$older', ['m:0100000000000000']);
        assert.equal(sourceOrderPermits(inbox, outbox, profile, '$later', 'dispatch'), true);
        const invalid = event('$invalid');
        invalid.content.file = {};
        const reply = event('$reply');
        reply.content['m.relates_to'] = {'m.in_reply_to': {event_id: '$older'}};
        const foreign = {...event('$foreign'), sender: '@foreign:invalid'};
        const unknownRoom = {...event('$unknown'), room_id: '!unknown:invalid'};
        inbox.accept('unsupported', {});
        inbox.complete('unsupported', [
            invalid,
            event('$image', 'm.image'),
            reply,
            foreign,
            unknownRoom,
        ]);
        assert.equal(ingress.drain(), 0);
        assert.equal(await worker.drain(), 3);
        assert.equal(notices.length, 3);
        assert(!notices.join('').includes('fixture.bin'));
        assert.equal(
            inbox.pendingEvents().length,
            2,
            'foreign and unowned events remain for other consumers',
        );
        inbox.accept('rejected', {});
        inbox.complete('rejected', [event('$rejected')]);
        outbox.rejectEvent(profile, '$rejected', room, 'Previously rejected.');
        ingress.drain();
        assert.equal(outbox.media.get(profile, '$rejected'), undefined);
        assert.equal(await worker.drain(), 1, 'prior durable rejection wins over new support');
        const png = event('$png', 'm.image');
        png.content.info = {size: 3, mimetype: 'image/png'};
        const jpeg = event('$jpeg', 'm.image');
        jpeg.content.info = {size: 3, mimetype: 'image/jpeg'};
        const gif = event('$gif', 'm.image');
        gif.content.info = {size: 3, mimetype: 'image/gif'};
        inbox.accept('images', {});
        const webp = event('$webp', 'm.image');
        webp.content.info = {size: 3, mimetype: 'image/webp'};
        const avif = event('$avif', 'm.image');
        avif.content.info = {size: 3, mimetype: 'image/avif'};
        inbox.complete('images', [png, jpeg, gif, webp, avif]);
        const imageWorker = new UnsupportedNoticeWorker({
            ...options,
            files: {maximumBytes: options.maximumBytes, imagesEnabled: true},
            ready: () => true,
            authorize: async () => {},
            send: async () => {},
        });
        assert.equal(await imageWorker.drain(), 1, 'Only unsupported AVIF gets a notice');
        assert.equal(outbox.rejection(profile, '$png'), undefined);
        assert.equal(outbox.rejection(profile, '$jpeg'), undefined);
        assert.equal(outbox.rejection(profile, '$gif'), undefined);
        assert.equal(outbox.rejection(profile, '$webp'), undefined);
        const images = new MediaIngress({...options, imagesEnabled: true});
        assert.equal(images.drain(), 4);
        assert.equal(outbox.media.get(profile, '$png')!.request.media.kind, 'm.image');
        assert.equal(outbox.media.get(profile, '$jpeg')!.request.media.mimeType, 'image/jpeg');
        const audio = event('$audio', 'm.audio');
        audio.content.info = {size: 3, mimetype: 'audio/flac'};
        const audioReply = event('$audio-reply', 'm.audio');
        audioReply.content.info = {size: 3, mimetype: 'audio/flac'};
        audioReply.content['m.relates_to'] = {'m.in_reply_to': {event_id: '$older'}};
        inbox.accept('audio', {});
        inbox.complete('audio', [audio, audioReply, event('$bad-audio', 'm.audio')]);
        assert.equal(ingress.drain(), 0, 'Audio requires explicit opt-in');
        const audioWorker = new UnsupportedNoticeWorker({
            ...options,
            files: {maximumBytes: options.maximumBytes, audioEnabled: true},
            ready: () => true,
            authorize: async () => {},
            send: async () => {},
        });
        assert.equal(await audioWorker.drain(), 2, 'Replies and non-audio MIME stay unsupported');
        assert.equal(outbox.rejection(profile, '$audio'), undefined);
        const audioIngress = new MediaIngress({...options, audioEnabled: true});
        assert.equal(audioIngress.drain(), 1);
        assert.equal(outbox.media.get(profile, '$audio')!.request.media.kind, 'm.audio');
        const video = event('$video', 'm.video');
        video.content.info = {size: 3, mimetype: 'video/mp4'};
        const videoReply = event('$video-reply', 'm.video');
        videoReply.content.info = {size: 3, mimetype: 'video/mp4'};
        videoReply.content['m.relates_to'] = {'m.in_reply_to': {event_id: '$older'}};
        inbox.accept('video', {});
        inbox.complete('video', [video, videoReply, event('$bad-video', 'm.video')]);
        assert.equal(ingress.drain(), 0, 'Video requires explicit opt-in');
        const videoWorker = new UnsupportedNoticeWorker({
            ...options,
            files: {maximumBytes: options.maximumBytes, videosEnabled: true},
            ready: () => true,
            authorize: async () => {},
            send: async () => {},
        });
        assert.equal(await videoWorker.drain(), 2, 'Video replies and wrong MIME get notices');
        assert.equal(outbox.rejection(profile, '$video'), undefined);
        const videoIngress = new MediaIngress({...options, videosEnabled: true});
        assert.equal(videoIngress.drain(), 1);
        assert.equal(outbox.media.get(profile, '$video')!.request.media.kind, 'm.video');
    } finally {
        inbox.close();
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
