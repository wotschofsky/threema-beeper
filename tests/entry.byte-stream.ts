import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {MessageChannel} from 'node:worker_threads';
import {test} from 'node:test';
import {serveByteStream, receiveByteStream} from '../src/threema/byte-stream.ts';

await test('worker byte transport is demand-driven and preserves bytes with bounded packets', async () => {
    const {port1, port2} = new MessageChannel();
    let generated = 0;
    const count = 5,
        size = 1024 * 1024;
    const source = Readable.from(
        (function* () {
            for (let i = 0; i < count; i++) {
                generated++;
                yield Buffer.alloc(size, i);
            }
        })(),
        {objectMode: false, highWaterMark: 64 * 1024},
    );
    const done = serveByteStream(port1, source, {bytes: count * size});
    const received = receiveByteStream(port2, {bytes: count * size});
    await delay(10);
    assert.equal(generated, 0, 'Opening a port must not eagerly read the file');
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
        received,
        new Writable({
            highWaterMark: 65536,
            write(chunk, _encoding, callback) {
                assert.ok(chunk.length <= 65536);
                bytes += chunk.length;
                hash.update(chunk);
                assert.ok(
                    generated * size - bytes <= 2 * size,
                    'Backpressure bounds source read-ahead',
                );
                setTimeout(callback, 1);
            },
        }),
    );
    await done;
    const expected = createHash('sha256');
    for (let i = 0; i < count; i++) expected.update(Buffer.alloc(size, i));
    assert.equal(bytes, count * size);
    assert.equal(hash.digest('hex'), expected.digest('hex'));
    assert.ok(source.destroyed);
});
await test('truncation, oversize chunks and source errors fail without forwarding source diagnostics', async () => {
    for (const [source, bytes] of [
        [Readable.from([Buffer.alloc(1)]), 2],
        [Readable.from([Buffer.alloc(1024 * 1024 + 1)]), 1024 * 1024 + 1],
        [
            new Readable({
                read() {
                    this.destroy(new Error('SECRET_LOCAL_PATH_AND_KEY'));
                },
            }),
            1,
        ],
    ] as const) {
        const {port1, port2} = new MessageChannel();
        const done = serveByteStream(port1, source, {bytes});
        const stream = receiveByteStream(port2, {bytes});
        await assert.rejects(
            async () => {
                for await (const _chunk of stream) {
                    /* Drain. */
                }
            },
            (error: Error) => !error.message.includes('SECRET'),
        );
        await done;
        assert.ok(source.destroyed);
    }
});
await test('consumer cancellation closes producer and unresponsive peers time out', async () => {
    const {port1, port2} = new MessageChannel();
    const source = Readable.from([Buffer.alloc(1024 * 1024)]);
    const abort = new AbortController();
    const done = serveByteStream(port1, source, {bytes: 1024 * 1024});
    const stream = receiveByteStream(port2, {bytes: 1024 * 1024, signal: abort.signal});
    await assert.rejects(async () => {
        for await (const _chunk of stream) abort.abort();
    }, /cancelled/);
    await done;
    assert.ok(source.destroyed);
    const stalled = new MessageChannel();
    const waiting = receiveByteStream(stalled.port1, {bytes: 1, timeoutMs: 15});
    await assert.rejects(async () => {
        for await (const _chunk of waiting) {
        }
    }, /timed out/);
    stalled.port2.close();
});
await test('unsolicited and oversized peer packets are rejected', async () => {
    for (const bytes of [Buffer.alloc(1), Buffer.alloc(65537)]) {
        const {port1, port2} = new MessageChannel();
        const stream = receiveByteStream(port1, {bytes: 65537});
        if (bytes.length > 1)
            port2.once('message', () => port2.postMessage({type: 'data', sequence: 0, bytes}));
        else port2.postMessage({type: 'data', sequence: 99, bytes});
        await assert.rejects(async () => {
            for await (const _chunk of stream) {
            }
        }, /Invalid/);
        port2.close();
    }
});
