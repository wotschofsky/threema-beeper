import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {DeletionDelivery} from '../src/matrix/deletion-delivery.ts';

await test('schema 5 mappings with unknown intermediate edits cannot claim complete deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-deletion-migration-'));
    const filename = join(directory, 'portals.sqlite');
    const key = randomBytes(32);
    const db = new Database(filename);
    db.pragma('cipher_compatibility=4');
    db.pragma(`key = "x'${key.toString('hex')}'"`);
    db.exec(
        'CREATE TABLE message_mappings(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,room TEXT NOT NULL,sender TEXT NOT NULL,root TEXT NOT NULL,latest TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(profile,chat,message)); PRAGMA user_version=5;',
    );
    db.prepare('INSERT INTO message_mappings VALUES (?,?,?,?,?,?,?,?)').run(
        'SELF1234',
        'c:TEST1234',
        'm:0100000000000000',
        '!room:matrix.invalid',
        '@ghost:matrix.invalid',
        '$original',
        '$latest',
        'synthetic',
    );
    db.close();
    const store = new PortalStore(filename, key);
    let redactions = 0;
    try {
        store.bind('SELF1234', 'c:TEST1234', '!room:matrix.invalid');
        await assert.rejects(
            new DeletionDelivery(store).apply(
                'SELF1234',
                'c:TEST1234',
                'm:0100000000000000',
                '!room:matrix.invalid',
                {
                    redact: async () => {
                        redactions++;
                        return '$redacted';
                    },
                },
            ),
            /event history reconciliation/,
        );
        assert.equal(redactions, 0);
        assert.equal(store.deletion('SELF1234', 'c:TEST1234', 'm:0100000000000000')?.done, 0);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
