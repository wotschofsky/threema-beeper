import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {RedactionSender} from '../src/matrix/redaction-sender.ts';

await test('redaction errors remain retryable and operation ID reuse cannot target another event', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-redaction-'));
    const key = randomBytes(32);
    const store = new PortalStore(join(directory, 'portals.sqlite'), key);
    const client = new MatrixClient('https://matrix.invalid', 'synthetic');
    let denied = true,
        requests = 0;
    client.doRequest = async (method, path, _query, body): Promise<any> => {
        requests++;
        assert.equal(method, 'PUT');
        assert.ok(path.endsWith('/redact/%24target/redact-1'));
        assert.deepEqual(body, {});
        assert.equal(store.operation('redact-1')?.event, null);
        if (denied) throw {errcode: 'M_FORBIDDEN'};
        return {event_id: '$redacted'};
    };
    const sender = new RedactionSender(store, {
        userId: '@bot:matrix.invalid',
        underlyingClient: client,
        enableEncryption: async () => {},
    });
    try {
        await assert.rejects(sender.redact('redact-1', '!room:matrix.invalid', '$target'));
        assert.equal(store.operation('redact-1')?.event, null);
        denied = false;
        assert.equal(
            await sender.redact('redact-1', '!room:matrix.invalid', '$target'),
            '$redacted',
        );
        assert.equal(
            await sender.redact('redact-1', '!room:matrix.invalid', '$target'),
            '$redacted',
        );
        await assert.rejects(
            sender.redact('redact-1', '!room:matrix.invalid', '$another'),
            /conflict/,
        );
        await assert.rejects(sender.redact('bad/id', '!room:matrix.invalid', '$target'), /Invalid/);
        assert.equal(requests, 2);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
