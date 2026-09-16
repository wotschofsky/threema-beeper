import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
// The git tarball installed with --ignore-scripts has no generated declarations.
// This is the narrow API exercised by the probe, not a replacement implementation.
const argon2: {
    readonly argon2id: number;
    hash(
        secret: Buffer,
        options: {type: number; memoryCost: number; timeCost: number},
    ): Promise<string>;
    verify(encoded: string, secret: Buffer): Promise<boolean>;
} = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/node_modules/argon2',
);

function openDatabase(filename: string, key: Buffer): Database.Database {
    assert.equal(key.length, 32);
    const db = new Database(filename);
    db.pragma('cipher_compatibility = 4');
    db.pragma(`key = "x'${key.toString('hex')}'"`);
    db.pragma('cipher_log_level = NONE');
    return db;
}

const childDirectory = process.argv[3];
if (process.argv[2] === '--child') {
    assert(childDirectory !== undefined);
    const key = await readFile(join(childDirectory, 'secret'));
    const db = openDatabase(join(childDirectory, 'probe.sqlite'), key);
    key.fill(0);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    db.prepare('INSERT INTO probe VALUES (?, ?)').run(
        'ffffffffffffffff',
        'synthetic-persistence-marker',
    );
    process.send?.({state: 'committed'});
    // The parent kills this process without db.close(), exercising WAL recovery.
    setInterval(() => undefined, 1000);
} else {
    await test(
        'Node 24 native SQLCipher survives SIGKILL and rejects a wrong key',
        {timeout: 30000},
        async (context) => {
            assert.equal(process.versions.node.split('.')[0], '24');
            const directory = await mkdtemp(join(tmpdir(), 'threema-beeper-native-probe-'));
            const key = randomBytes(32);
            let child: ReturnType<typeof fork> | undefined;
            try {
                await writeFile(join(directory, 'secret'), key, {mode: 0o400, flag: 'wx'});
                child = fork(fileURLToPath(import.meta.url), ['--child', directory], {
                    execPath: process.execPath,
                    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                });
                const exit = once(child, 'exit');
                const committed = await Promise.race([
                    once(child, 'message', {signal: context.signal}),
                    exit.then(() => {
                        throw new Error('Child exited before commit');
                    }),
                ]);
                assert.deepEqual(committed[0], {state: 'committed'});
                child.kill('SIGKILL');
                const [, signal] = await exit;
                assert.equal(signal, 'SIGKILL');

                const filename = join(directory, 'probe.sqlite');
                const db = openDatabase(filename, key);
                try {
                    assert.match(String(db.pragma('cipher_version', {simple: true})), /^4\./u);
                    assert.equal(db.pragma('integrity_check', {simple: true}), 'ok');
                    assert.deepEqual(db.prepare('SELECT * FROM probe').get(), {
                        id: 'ffffffffffffffff',
                        body: 'synthetic-persistence-marker',
                    });
                } finally {
                    db.close();
                }
                const wrongKey = randomBytes(32);
                const wrong = openDatabase(filename, wrongKey);
                wrongKey.fill(0);
                try {
                    assert.throws(() => wrong.prepare('SELECT * FROM probe').get());
                } finally {
                    wrong.close();
                }
                const bytes = await readFile(filename);
                assert.equal(bytes.includes(Buffer.from('SQLite format 3')), false);
                assert.equal(bytes.includes(Buffer.from('synthetic-persistence-marker')), false);
            } finally {
                if (child !== undefined && child.exitCode === null && child.signalCode === null) {
                    const exit = once(child, 'exit');
                    child.kill('SIGKILL');
                    await exit;
                }
                key.fill(0);
                await rm(directory, {recursive: true, force: true});
            }
        },
    );

    await test('pinned Argon2 hashes and verifies under Node 24', async () => {
        const secret = randomBytes(32);
        try {
            const encoded = await argon2.hash(secret, {
                type: argon2.argon2id,
                memoryCost: 8192,
                timeCost: 2,
            });
            assert.equal(await argon2.verify(encoded, secret), true);
            assert.equal(await argon2.verify(encoded, randomBytes(32)), false);
        } finally {
            secret.fill(0);
        }
    });
}
