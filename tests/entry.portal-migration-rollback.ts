import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';

for (const failure of ['history-copy', 'final-index']) {
    await test(`portal migration rolls back schema and data after ${failure} failure`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'portal-migration-rollback-'));
        const filename = join(directory, 'portals.sqlite');
        const key = randomBytes(32);
        function open(): Database.Database {
            const db = new Database(filename);
            db.pragma('cipher_compatibility=4');
            db.pragma(`key = "x'${key.toString('hex')}'"`);
            return db;
        }
        function snapshot(db: Database.Database) {
            return {
                version: db.pragma('user_version', {simple: true}),
                schema: db
                    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
                    .all(),
                mappings: db.prepare('SELECT * FROM message_mappings').all(),
            };
        }
        try {
            const db = open();
            db.exec(
                'CREATE TABLE message_mappings(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,room TEXT NOT NULL,sender TEXT NOT NULL,root TEXT NOT NULL,latest TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(profile,chat,message)); PRAGMA user_version=5;',
            );
            db.prepare('INSERT INTO message_mappings VALUES (?,?,?,?,?,?,?,?)').run(
                'SELF1234',
                'c:TEST1234',
                'm:0100000000000000',
                '!fixture:invalid',
                '@fixture:invalid',
                '$original',
                '$latest',
                'fixture',
            );
            if (failure === 'history-copy') {
                db.exec(
                    "CREATE TABLE message_histories(profile TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(profile,chat,message)); CREATE TRIGGER fail_migration BEFORE INSERT ON message_histories BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;",
                );
            } else {
                db.exec('CREATE TABLE encrypted_echo_event(fixture TEXT)');
            }
            const before = snapshot(db);
            db.close();
            for (let attempt = 0; attempt < 2; attempt++) {
                assert.throws(
                    () => new PortalStore(filename, key),
                    failure === 'history-copy'
                        ? /injected migration failure/
                        : /already a table named encrypted_echo_event/,
                );
                const inspected = open();
                try {
                    assert.deepEqual(
                        snapshot(inspected),
                        before,
                        'Failed migration must leave the old schema, version and mappings intact',
                    );
                    if (failure === 'history-copy')
                        assert.equal(
                            (
                                inspected
                                    .prepare('SELECT count(*) AS n FROM message_histories')
                                    .get() as {n: number}
                            ).n,
                            0,
                        );
                } finally {
                    inspected.close();
                }
            }
            const repaired = open();
            repaired.exec(
                failure === 'history-copy'
                    ? 'DROP TRIGGER fail_migration'
                    : 'DROP TABLE encrypted_echo_event',
            );
            repaired.close();
            const migrated = new PortalStore(filename, key);
            migrated.close();
            const verified = open();
            try {
                assert.equal(verified.pragma('user_version', {simple: true}), 9);
                assert.deepEqual(
                    verified.prepare('SELECT * FROM message_mappings').all(),
                    before.mappings,
                );
                assert.equal(
                    (
                        verified.prepare('SELECT count(*) AS n FROM message_versions').get() as {
                            n: number;
                        }
                    ).n,
                    2,
                );
                assert.equal(
                    (
                        verified.prepare('SELECT complete FROM message_histories').get() as {
                            complete: number;
                        }
                    ).complete,
                    0,
                );
                assert.equal(verified.pragma('integrity_check', {simple: true}), 'ok');
            } finally {
                verified.close();
            }
            new PortalStore(filename, key).close();
        } finally {
            key.fill(0);
            rmSync(directory, {recursive: true, force: true});
        }
    });
}
