import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UploadLimits} from '../src/media/upload-limits.ts';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';

await test('upload discovery enforces all limits, refreshes, and fails on outage or invalid configuration', async () => {
    const client = new MatrixClient('https://matrix.invalid', 'synthetic');
    let time = 0,
        calls = 0,
        unavailable = false;
    let config: unknown = {'m.upload.size': 200};
    client.doesServerSupportVersion = async () => true;
    client.doRequest = async (_method, path): Promise<any> => {
        assert.equal(path, '/_matrix/client/v1/media/config');
        calls++;
        if (unavailable) throw new Error('synthetic outage');
        return config;
    };
    const limits = new UploadLimits(
        client,
        async () => ({maximumBytes: 300}),
        400,
        () => time,
    );
    assert.deepEqual(await Promise.all([limits.get(), limits.get()]), [200, 200]);
    assert.equal(calls, 1);
    time = 60001;
    unavailable = true;
    await assert.rejects(limits.get(), /outage/);
    unavailable = false;
    config = {'m.upload.size': -1};
    await assert.rejects(limits.get(), /Invalid Matrix/);
    config = {};
    assert.equal(await limits.get(), 300);
    time += 60001;
    config = {'m.upload.size': 0};
    assert.equal(await limits.get(), 0);
    const local = new UploadLimits(client, async () => ({maximumBytes: 300}), 100);
    config = {'m.upload.size': 200};
    assert.equal(await local.get(), 100);
    client.doesServerSupportVersion = async () => false;
    client.doRequest = async (_method, path): Promise<any> => {
        assert.equal(path, '/_matrix/media/v3/config');
        return {'m.upload.size': 50};
    };
    assert.equal(await new UploadLimits(client, async () => ({maximumBytes: 300}), 100).get(), 50);
});
