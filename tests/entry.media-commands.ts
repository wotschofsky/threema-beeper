import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {MessageChannel} from 'node:worker_threads';
import {test} from 'node:test';
import {MediaCommands} from '../src/threema/media-commands.ts';
import {receiveByteStream} from '../src/threema/byte-stream.ts';

const bytes = Buffer.from('worker retained media');
const info = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: 'application/octet-stream',
};
const request = {
    chatId: 'c:TEST1234',
    messageId: 'm:ffffffffffffffff',
    part: 'file',
    maximumBytes: 100,
};
await test('media commands whitelist metadata and stream only an unchanged source', async () => {
    let opened = 0;
    const commands = new MediaCommands(async () => ({
        ...info,
        secret: 'not-for-parent',
        open: () => {
            opened++;
            return Readable.from([bytes]);
        },
    }));
    assert.deepEqual(await commands.info(request), info);
    assert.equal(opened, 0);
    const wrong = new MessageChannel();
    await assert.rejects(
        commands.stream(request, {...info, sha256: '0'.repeat(64)}, wrong.port1),
        /changed/,
    );
    wrong.port2.close();
    assert.equal(opened, 0);
    const {port1, port2} = new MessageChannel();
    assert.deepEqual(await commands.stream(request, info, port1), info);
    const collected: Buffer[] = [];
    for await (const chunk of receiveByteStream(port2, {bytes: info.bytes})) collected.push(chunk);
    assert.deepEqual(Buffer.concat(collected), bytes);
    assert.equal(opened, 1);
    await assert.rejects(commands.info({...request, messageId: 'invalid'}), /Invalid/);
});
await test('concurrent media hashing and streams share a fixed operation limit', async () => {
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
        resolve = done;
    });
    const commands = new MediaCommands(async () => {
        await ready;
        return {...info, open: () => Readable.from([bytes])};
    });
    const tasks = Array.from({length: 4}, () => commands.info(request));
    await assert.rejects(commands.info(request), /Too many/);
    resolve();
    await Promise.all(tasks);
    assert.deepEqual(await commands.info(request), info);
});
