import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePreparedImageSend} from '../src/threema/prepared-image-send.ts';
await test('prepared image IPC snapshots bounded dimensions and distinct opaque tokens', () => {
    const request = {
        profile: 'SELF1234',
        chatId: 'c:ABCD1234',
        token: 'a'.repeat(64),
        thumbnailToken: 'b'.repeat(64),
        fileName: 'Bild 😀.png',
        mediaType: 'image/png',
        thumbnailMediaType: 'image/png',
        width: 2048,
        height: 1024,
        thumbnailWidth: 512,
        thumbnailHeight: 256,
        caption: 'Caption',
    };
    const jpeg = {...request, mediaType: 'image/jpeg', thumbnailMediaType: 'image/jpeg'};
    assert.deepEqual(parsePreparedImageSend(jpeg), jpeg);
    const gif = {...jpeg, mediaType: 'image/gif'};
    assert.deepEqual(parsePreparedImageSend(gif), gif);
    const webp = {...jpeg, mediaType: 'image/webp'};
    assert.deepEqual(parsePreparedImageSend(webp), webp);
    assert.throws(() => parsePreparedImageSend({...gif, thumbnailMediaType: 'image/gif'}));
    const mixed = {...request, thumbnailMediaType: 'image/jpeg', width: 1, height: 1};
    assert.deepEqual(parsePreparedImageSend(mixed), mixed);
    const parsed = parsePreparedImageSend(request);
    assert.deepEqual(parsed, request);
    request.width = 10;
    assert.equal(parsed.width, 2048);
    for (const change of [
        {thumbnailToken: parsed.token},
        {thumbnailToken: 'not-a-token'},
        {mediaType: 'image/avif'},
        {thumbnailMediaType: 'image/gif'},
        {width: 0},
        {height: 8193},
        {width: 1.5},
        {height: NaN},
        {thumbnailWidth: 513},
        {thumbnailHeight: 0},
        {fileName: '../private'},
        {chatId: 'wrong'},
        {key: 'secret'},
        {fileData: {}},
    ])
        assert.throws(() => parsePreparedImageSend({...parsed, ...change}));
});
