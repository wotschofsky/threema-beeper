import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {createVideoStaging} from '../src/media/video-staging.ts';
import type {PreparedVideoFallback} from '../src/media/video-fallback.ts';

const request = {
    id: 'video',
    profile: 'SELF1234',
    chatId: 'c:ABCD1234',
    fileName: 'Original ü.mov',
    caption: 'caption',
};
const part = (
    encoding: 'avc' | 'original',
    dispose: () => Promise<void> = async () => {},
): PreparedVideoFallback => {
    const attachment = {
        bytes: 3,
        read: async (start: number, end: number) => Buffer.from('abc').subarray(start, end),
        stream: () => Readable.from([Buffer.from('abc')]),
        dispose,
    };
    return encoding === 'avc'
        ? {
              encoding,
              prepared: {
                  attachment,
                  metadata: {
                      mimeType: 'video/mp4',
                      bytes: 3,
                      durationSeconds: 1.25,
                      width: 640,
                      height: 360,
                  },
              },
          }
        : {encoding, prepared: {attachment, metadata: {mimeType: 'video/quicktime', bytes: 3}}};
};
for (const encoding of ['avc', 'original'] as const)
    await test(`video staging produces opaque command and canonical ${encoding} projection`, async () => {
        let disposed = 0,
            discarded = 0;
        const stage = createVideoStaging({
            prepareFile: async (command, stream) => {
                assert.equal(command.profile, request.profile);
                assert.equal(command.chatId, request.chatId);
                assert.equal(command.bytes, 3);
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.from(chunk));
                assert.equal(Buffer.concat(chunks).toString(), 'abc');
                return '1'.repeat(64);
            },
            discardPreparedFile: async (command) => {
                assert.equal(command.token, '1'.repeat(64));
                discarded++;
                return true;
            },
        });
        const prepared = await stage(
            request,
            part(encoding, async () => {
                disposed++;
            }),
        );
        assert.equal(disposed, 1);
        assert.equal(discarded, 0);
        assert.equal(prepared.request.token, '1'.repeat(64));
        assert.equal(prepared.projection.caption, request.caption);
        assert(!('token' in prepared.projection));
        if (encoding === 'avc') {
            assert.equal(prepared.projection.kind, 'video');
            assert.match(prepared.request.fileName, /^threema-\d+\.mp4$/);
            assert('durationSeconds' in prepared.request);
            assert.equal(prepared.request.durationSeconds, 1.25);
            assert(!('thumbnailToken' in prepared.request));
        } else {
            assert.equal(prepared.projection.kind, 'file');
            assert.equal(prepared.request.fileName, request.fileName);
            assert.equal(prepared.request.mediaType, 'video/quicktime');
            assert(!('durationSeconds' in prepared.request));
            assert(!('audioDurationSeconds' in prepared.request));
        }
        await prepared.discard();
        await prepared.discard();
        assert.equal(discarded, 1);
        assert.equal(disposed, 1);
    });

await test('video staging retains failed token and spool cleanup before retrying', async () => {
    let prepares = 0,
        fail = true,
        oldDisposals = 0,
        freshDisposals = 0;
    const retained = new Set<string>();
    const stage = createVideoStaging({
        prepareFile: async (_request, stream) => {
            for await (const _chunk of stream) {
            }
            const token = String(++prepares).repeat(64);
            retained.add(token);
            return token;
        },
        discardPreparedFile: async ({token}) => {
            if (fail) throw new Error('Failed token cleanup');
            return retained.delete(token);
        },
    });
    const old = part('avc', async () => {
        oldDisposals++;
        if (fail) throw new Error('Failed spool cleanup');
    });
    await assert.rejects(stage(request, old));
    assert.equal(prepares, 1);
    assert.equal(retained.size, 1);
    await assert.rejects(
        stage(
            request,
            part('avc', async () => {
                freshDisposals++;
            }),
        ),
    );
    assert.equal(prepares, 1);
    assert.equal(freshDisposals, 1);
    fail = false;
    const prepared = await stage(
        request,
        part('avc', async () => {
            freshDisposals++;
        }),
    );
    assert(oldDisposals >= 3);
    assert.equal(prepares, 2);
    assert.equal(retained.size, 1);
    await prepared.discard();
    assert.equal(retained.size, 0);
    assert.equal(freshDisposals, 2);
});

await test('video staging rejects size conflicts and cleans a token allocated during cancellation', async () => {
    let prepares = 0,
        discards = 0,
        disposals = 0;
    const abort = new AbortController();
    const stage = createVideoStaging({
        prepareFile: async (_request, stream) => {
            for await (const _chunk of stream) {
            }
            prepares++;
            abort.abort();
            return '1'.repeat(64);
        },
        discardPreparedFile: async () => {
            discards++;
            return true;
        },
    });
    const invalid = part('avc', async () => {
        disposals++;
    });
    invalid.prepared.metadata.bytes = 4;
    await assert.rejects(stage(request, invalid));
    assert.equal(prepares, 0);
    assert.equal(disposals, 1);
    await assert.rejects(
        stage(
            request,
            part('avc', async () => {
                disposals++;
            }),
            abort.signal,
        ),
    );
    assert.equal(prepares, 1);
    assert.equal(discards, 1);
    assert.equal(disposals, 2);
});

await test('video thumbnail staging cleans partial bundles and hands off distinct tokens', async () => {
    let prepares = 0,
        failSecond = true,
        disposals = 0;
    const retained = new Set<string>();
    const stage = createVideoStaging({
        prepareFile: async (request, stream) => {
            let bytes = 0;
            for await (const chunk of stream) bytes += chunk.length;
            assert.equal(bytes, request.bytes);
            prepares++;
            if (failSecond && prepares === 2) throw new Error('Thumbnail preparation failed');
            const token = String(prepares).repeat(64);
            retained.add(token);
            return token;
        },
        discardPreparedFile: async ({token}) => retained.delete(token),
    });
    const bundle = (): PreparedVideoFallback => {
        const main = part('avc', async () => {
            disposals++;
        });
        assert(main.encoding === 'avc');
        return {
            ...main,
            thumbnail: {
                metadata: {mimeType: 'image/jpeg', width: 320, height: 180, bytes: 4},
                attachment: {
                    bytes: 4,
                    read: async (start, end) => Buffer.from('jpeg').subarray(start, end),
                    stream: () => Readable.from([Buffer.from('jpeg')]),
                    dispose: async () => {
                        disposals++;
                    },
                },
            },
        };
    };
    await assert.rejects(stage(request, bundle()));
    assert.equal(retained.size, 0);
    assert.equal(disposals, 2);
    failSecond = false;
    const prepared = await stage(request, bundle());
    assert.equal(disposals, 4);
    assert.equal(retained.size, 2);
    assert('thumbnailToken' in prepared.request);
    assert.notEqual(prepared.request.token, prepared.request.thumbnailToken);
    assert.equal(prepared.request.thumbnailMediaType, 'image/jpeg');
    assert.equal(prepared.request.thumbnailWidth, 320);
    assert.equal(prepared.request.thumbnailHeight, 180);
    assert(prepared.projection.kind === 'video');
    assert.equal(prepared.projection.thumbnailBytes, 4);
    assert.equal(prepared.projection.thumbnailMediaType, 'image/jpeg');
    await prepared.discard();
    assert.equal(retained.size, 0);
    assert.equal(disposals, 4);
});
