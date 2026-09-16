import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {OutboxStore} from '../src/outbox/store.ts';

await test('outbox rejection decisions survive restart and schema migration without changing accepted work', () => {
    const root = mkdtempSync(join(tmpdir(), 'outbox-rejections-')),
        key = randomBytes(32),
        path = join(root, 'outbox.sqlite');
    let store = new OutboxStore(path, key);
    const request = {
        requestId: '01900000-0000-7000-8000-000000000001',
        profile: 'SELF1234',
        transactionId: 'txn',
        eventId: '$accepted',
        roomId: '!room:invalid',
        sender: '@owner:invalid',
        chatId: 'c:TEST1234',
        text: 'accepted text',
    };
    try {
        store.prepare(request);
        store.close();
        const previous = new Database(path);
        try {
            previous.pragma('cipher_log_level = NONE');
            previous.pragma('cipher_compatibility = 4');
            previous.pragma(`key = "x'${key.toString('hex')}'"`);
            previous.exec('DROP TABLE rejections; PRAGMA user_version=2;');
        } finally {
            previous.close();
        }
        store = new OutboxStore(path, key);
        assert.equal(store.get(request.requestId)?.state, 'PREPARED');
        assert.throws(() =>
            store.rejectEvent(request.profile, request.eventId, request.roomId, 'unsupported'),
        );
        store.rejectEvent(request.profile, '$rejected', request.roomId, 'Original reason');
        store.rejectEvent(request.profile, '$rejected', request.roomId, 'Original reason');
        assert.throws(() =>
            store.rejectEvent(request.profile, '$rejected', request.roomId, 'Changed reason'),
        );
        store.close();
        store = new OutboxStore(path, key);
        assert.equal(store.rejection(request.profile, '$rejected')?.reason, 'Original reason');
        assert.throws(
            () =>
                store.prepare({
                    ...request,
                    requestId: '01900000-0000-7000-8000-000000000002',
                    eventId: '$rejected',
                }),
            /Rejected event/,
        );
        assert.equal(store.claim()?.request.eventId, '$accepted');
    } finally {
        store.close();
        key.fill(0);
        rmSync(root, {recursive: true, force: true});
    }
});
