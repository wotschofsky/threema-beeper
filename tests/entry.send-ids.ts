import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';

interface Message {
    id: bigint;
    type: string;
    text?: string;
    quotedMessageId?: bigint;
}
interface Sender {
    _sendFragmentsWithIds(
        this: unknown,
        fragments: unknown[],
        hook?: unknown,
    ): Promise<readonly bigint[]>;
    sendStoredFileWithIds(
        this: unknown,
        detail: unknown,
        hook?: unknown,
    ): Promise<readonly bigint[]>;
    sendMessageWithIds(
        this: unknown,
        detail: unknown,
        beforeSend?: (ids: readonly bigint[]) => Promise<void>,
    ): Promise<readonly bigint[]>;
    sendMessage(this: unknown, detail: unknown): Promise<void>;
}
const {ProbeSendController} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {ProbeSendController: {prototype: Sender}};
function sendWithIds(
    context: unknown,
    detail: unknown,
    record?: (ids: readonly bigint[]) => Promise<void>,
) {
    const method = ProbeSendController.prototype.sendMessageWithIds as unknown as (
        this: unknown,
        detail: unknown,
        hook?: {record: (ids: readonly bigint[]) => Promise<void>},
    ) => Promise<readonly bigint[]>;
    return method.call(context, detail, record ? {record} : undefined);
}
function fixture(failAt = -1) {
    let next = 0xfffffffffffffff0n;
    const sent: Message[] = [];
    const context = {
        _services: {
            crypto: {
                randomBytes(view: Uint8Array) {
                    new DataView(view.buffer, view.byteOffset, view.byteLength).setBigUint64(
                        0,
                        next++,
                        true,
                    );
                    return view;
                },
            },
        },
        _log: {debug() {}},
        _conversation: {
            get: () => ({
                controller: {
                    addMessage: {
                        fromLocal: async (message: Message) => {
                            if (sent.length === failAt) throw new Error('synthetic add failure');
                            sent.push(message);
                        },
                    },
                },
            }),
        },
        _prepareFileBasedMessageInitFragments: async () => [
            {type: 'file'},
            {type: 'image'},
            {type: 'video'},
        ],
        _sendFragmentsWithIds: ProbeSendController.prototype._sendFragmentsWithIds,
        sendMessageWithIds: ProbeSendController.prototype.sendMessageWithIds,
    };
    return {context, sent};
}
await test('real send controller awaits all allocated IDs before adding text or multiple prepared fragments', async () => {
    for (const detail of [
        {type: 'text', text: 'synthetic text', quotedMessageId: 0xffffffffffffffffn},
        {type: 'files', files: []},
    ]) {
        const {context, sent} = fixture();
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        let recorded: readonly bigint[] = [];
        const result = sendWithIds(context, detail, async (ids) => {
            recorded = [...ids];
            // Mutating the callback's copy cannot change generated messages or the returned IDs.
            (ids as bigint[]).fill(0n);
            await wait;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(sent.length, 0);
        assert.equal(recorded.length, detail.type === 'text' ? 1 : 3);
        assert.ok(recorded.every((id) => id > BigInt(Number.MAX_SAFE_INTEGER)));
        release();
        assert.deepEqual(await result, recorded);
        assert.deepEqual(
            sent.map(({id}) => id),
            recorded,
        );
        if (detail.type === 'text') {
            assert.equal(sent[0]!.text, detail.text);
            assert.equal(sent[0]!.quotedMessageId, detail.quotedMessageId);
        }
    }
});
await test('persistence failure sends nothing; partial add failure exposes no false success or implicit retry', async () => {
    const rejected = fixture();
    await assert.rejects(
        sendWithIds(rejected.context, {type: 'text', text: 'fixture'}, async () => {
            throw new Error('durable record failed');
        }),
        /durable record failed/,
    );
    assert.equal(rejected.sent.length, 0);
    const partial = fixture(1);
    let recorded: readonly bigint[] = [];
    await assert.rejects(
        sendWithIds(partial.context, {type: 'files', files: []}, async (ids) => {
            recorded = ids;
        }),
        /synthetic add failure/,
    );
    assert.equal(recorded.length, 3);
    assert.equal(partial.sent.length, 1);
    assert.equal(partial.sent[0]!.id, recorded[0]);
    const legacy = fixture();
    assert.equal(
        await ProbeSendController.prototype.sendMessage.call(legacy.context, {
            type: 'text',
            text: 'legacy fixture',
        }),
        undefined,
    );
    assert.equal(legacy.sent.length, 1);
});

await test('worker-local prepared files reuse the ID barrier without loading or storing blob bytes', async () => {
    const {context, sent} = fixture();
    const fileData = {
        fileId: 'a'.repeat(48),
        unencryptedByteCount: 42,
        storageFormatVersion: 1,
        encryptionKey: {workerLocal: true},
    };
    const detail = {
        type: 'stored-file',
        fileData,
        fileName: 'fixture.bin',
        mediaType: 'application/octet-stream',
        caption: 'caption',
    };
    let recorded: readonly bigint[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const sending = ProbeSendController.prototype.sendStoredFileWithIds.call(context, detail, {
        record: async (ids: readonly bigint[]) => {
            recorded = [...ids];
            await wait;
        },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(recorded.length, 1);
    assert.equal(sent.length, 0);
    release();
    assert.deepEqual(await sending, recorded);
    assert.equal((sent[0] as any).fileData, fileData);
    assert.equal((sent[0] as any).fileSize, 42);
    assert.equal((sent[0] as any).caption, 'caption');
    const failed = fixture();
    await assert.rejects(
        ProbeSendController.prototype.sendStoredFileWithIds.call(failed.context, detail, {
            record: async () => {
                throw new Error('journal unavailable');
            },
        }),
    );
    assert.equal(failed.sent.length, 0);
    await assert.rejects(
        ProbeSendController.prototype.sendStoredFileWithIds.call(failed.context, {
            ...detail,
            fileData: {...fileData, unencryptedByteCount: -1},
        }),
    );
    assert.equal(failed.sent.length, 0);
});

await test('native prepared images retain their thumbnail and allocate IDs before model insertion', async () => {
    const {context, sent} = fixture();
    const fileData = {
        fileId: 'a'.repeat(48),
        unencryptedByteCount: 100,
        storageFormatVersion: 1,
        encryptionKey: {workerLocal: true},
    };
    const thumbnailFileData = {...fileData, fileId: 'b'.repeat(48), unencryptedByteCount: 20};
    const detail = {
        type: 'stored-image',
        fileData,
        thumbnailFileData,
        fileName: 'image.png',
        mediaType: 'image/png',
        thumbnailMediaType: 'image/png',
        dimensions: {width: 1024, height: 512},
        thumbnailDimensions: {width: 512, height: 256},
        caption: 'Image caption',
    };
    const ids = await ProbeSendController.prototype.sendStoredFileWithIds.call(context, detail, {
        record: async (allocated: readonly bigint[]) => {
            assert.equal(allocated.length, 1);
            assert.equal(sent.length, 0);
        },
    });
    assert.equal(ids.length, 1);
    const image = sent[0] as any;
    assert.equal(image.type, 'image');
    assert.equal(image.fileData, fileData);
    assert.equal(image.thumbnailFileData, thumbnailFileData);
    assert.deepEqual(image.dimensions, detail.dimensions);
    assert.equal(image.animated, false);
    assert.equal(image.caption, detail.caption);
    for (const changed of [
        {dimensions: {width: 0, height: 1}},
        {thumbnailDimensions: {width: 513, height: 256}},
        {thumbnailFileData: fileData},
        {mediaType: 'image/jpeg'},
    ]) {
        const invalid = fixture();
        await assert.rejects(
            ProbeSendController.prototype.sendStoredFileWithIds.call(
                invalid.context,
                {...detail, ...changed},
                {record: async () => assert.fail('Invalid image reached allocation')},
            ),
        );
        assert.equal(invalid.sent.length, 0);
    }
    const failed = fixture();
    await assert.rejects(
        ProbeSendController.prototype.sendStoredFileWithIds.call(failed.context, detail, {
            record: async () => {
                throw new Error('synthetic journal failure');
            },
        }),
    );
    assert.equal(failed.sent.length, 0);
});
