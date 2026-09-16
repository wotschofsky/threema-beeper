import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {createImageStaging} from '../src/media/image-staging.ts';
await test('image staging cleans a partial worker bundle and retries cleanup before preparing again', async () => {
    let prepares = 0,
        failSecond = true,
        failCleanup = true,
        disposed = 0;
    const retained = new Set<string>();
    const stage = createImageStaging({
        prepareFile: async (request, stream) => {
            prepares++;
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk);
            assert.equal(Buffer.concat(chunks).length, request.bytes);
            if (failSecond && prepares === 2) throw new Error('synthetic thumbnail failure');
            const token = prepares.toString(16).padStart(64, '0');
            retained.add(token);
            return token;
        },
        discardPreparedFile: async ({token}) => {
            if (failCleanup) throw new Error('synthetic cleanup failure');
            return retained.delete(token);
        },
    });
    const part = (width: number) => ({
        metadata: {width, height: width, bytes: 3, mimeType: 'image/png' as const},
        attachment: {
            bytes: 3,
            read: async (start: number, end: number) => Buffer.from('abc').subarray(start, end),
            stream: () => Readable.from([Buffer.from('abc')]),
            dispose: async () => {},
        },
    });
    const bundle = () => ({
        image: part(16),
        thumbnail: part(8),
        dispose: async () => {
            disposed++;
        },
    });
    const request = {
        id: 'request',
        profile: 'SELF1234',
        chatId: 'c:ABCD1234',
        fileName: 'image.png',
    };
    await assert.rejects(stage(request, bundle()));
    assert.equal(retained.size, 1);
    await assert.rejects(stage(request, bundle()));
    assert.equal(prepares, 2, 'Failed retained cleanup prevents new worker files');
    failCleanup = false;
    failSecond = false;
    const result = await stage(request, bundle());
    assert.equal(prepares, 4);
    assert.equal(retained.size, 2);
    assert.equal(result.request.width, 16);
    assert.equal(result.request.thumbnailWidth, 8);
    assert.notEqual(result.request.token, result.request.thumbnailToken);
    await result.discard();
    assert.equal(retained.size, 0);
    assert.equal(disposed, 3);
});

await test('image staging preserves independent PNG main and JPEG thumbnail metadata', async () => {
    let preparedParts = 0;
    const stage = createImageStaging({
        prepareFile: async (request, stream) => {
            preparedParts++;
            assert.equal(request.bytes, 3);
            for await (const _chunk of stream) {
                /* Drain the synthetic source. */
            }
            return preparedParts.toString().repeat(64);
        },
        discardPreparedFile: async () => true,
    });
    const part = (mimeType: 'image/png' | 'image/jpeg', width: number) => ({
        metadata: {mimeType, width, height: width, bytes: 3},
        attachment: {
            bytes: 3,
            read: async (start: number, end: number) => Buffer.from('abc').subarray(start, end),
            stream: () => Readable.from([Buffer.from('abc')]),
            dispose: async () => {},
        },
    });
    let disposed = false;
    const prepared = await stage(
        {id: 'mixed', profile: 'SELF1234', chatId: 'c:ABCD1234', fileName: 'picture.avif'},
        {
            image: part('image/png', 1),
            thumbnail: part('image/jpeg', 8),
            dispose: async () => {
                disposed = true;
            },
        },
    );
    assert.equal(preparedParts, 2);
    assert.equal(prepared.request.mediaType, 'image/png');
    assert.equal(prepared.request.thumbnailMediaType, 'image/jpeg');
    assert.equal(prepared.request.width, 1);
    assert.equal(prepared.request.thumbnailWidth, 8);
    assert(disposed);
    await prepared.discard();
});
