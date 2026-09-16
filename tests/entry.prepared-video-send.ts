import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePreparedVideoSend} from '../src/threema/prepared-video-send.ts';

await test('prepared video command separates video metadata and optional complete thumbnail from storage secrets', () => {
    const video = {
        profile: 'SELF1234',
        chatId: 'c:ABCD1234',
        token: 'a'.repeat(64),
        fileName: 'Clip 🎥.mp4',
        mediaType: 'video/mp4',
        durationSeconds: 1.25,
        width: 1920,
        height: 1080,
        caption: 'Caption',
    };
    assert.deepEqual(parsePreparedVideoSend(video), video);
    const thumbnail = {
        thumbnailToken: 'b'.repeat(64),
        thumbnailMediaType: 'image/jpeg',
        thumbnailWidth: 256,
        thumbnailHeight: 144,
    };
    const parsed = parsePreparedVideoSend({...video, ...thumbnail});
    assert.deepEqual(parsed, {...video, ...thumbnail});
    video.width = 640;
    assert.equal(parsed.width, 1920, 'The validated command owns its metadata');
    for (const duration of [0, -1, NaN, Infinity, 10001, '1.25', null])
        assert.throws(() => parsePreparedVideoSend({...video, durationSeconds: duration}));
    for (const size of [0, -1, 8193, 1.5, '640', null])
        assert.throws(() => parsePreparedVideoSend({...video, width: size}));
    for (const key of Object.keys(thumbnail)) {
        const incomplete: Record<string, unknown> = {...video, ...thumbnail};
        delete incomplete[key];
        assert.throws(() => parsePreparedVideoSend(incomplete));
    }
    for (const extra of [
        {audioDurationSeconds: 1.25},
        {fileData: {}},
        {encryptionKey: 'secret'},
        {mediaType: 'video/webm'},
        {token: 'bad'},
        {replyTo: 'm:0100000000000000'},
        {...thumbnail, thumbnailToken: video.token},
        {...thumbnail, thumbnailWidth: 513},
        {...thumbnail, thumbnailMediaType: 'image/webp'},
        {thumbnailToken: undefined},
    ])
        assert.throws(() => parsePreparedVideoSend({...video, ...extra}));
});
