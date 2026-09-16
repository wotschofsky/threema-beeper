import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, realpath, readdir, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {encryptArchive, decryptArchive} from '../src/backup/archive-crypto.ts';

await test('backup encryption authenticates before publication and rejects corruption, wrong keys and overwrites', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'backup-crypto-'));
    const key = randomBytes(32);
    try {
        const archive = join(root, 'encrypted'),
            output = join(root, 'restored');
        const content = randomBytes(1024 * 1024);
        await encryptArchive(
            Readable.from([content.subarray(0, 123), content.subarray(123)]),
            archive,
            key,
        );
        assert.equal((await stat(archive)).mode & 0o777, 0o600);
        const encrypted = await readFile(archive);
        assert(!encrypted.includes(content));
        await decryptArchive(archive, output, key);
        assert((await readFile(output)).equals(content));
        await assert.rejects(decryptArchive(archive, output, key));
        assert((await readFile(output)).equals(content));
        await rm(output);
        await assert.rejects(decryptArchive(archive, output, randomBytes(32)));
        for (const position of [0, 10, 30, encrypted.length - 1]) {
            const changed = Buffer.from(encrypted);
            changed[position] = changed[position]! ^ 1;
            await writeFile(archive, changed);
            await assert.rejects(decryptArchive(archive, output, key));
            assert.deepEqual(await readdir(root), ['encrypted']);
        }
        await writeFile(archive, encrypted.subarray(0, 25));
        await assert.rejects(decryptArchive(archive, output, key));
        await assert.rejects(
            encryptArchive(
                Readable.from(
                    (async function* () {
                        yield Buffer.from('partial');
                        throw new Error('synthetic source failure');
                    })(),
                ),
                join(root, 'failed'),
                key,
            ),
        );
        assert.deepEqual(await readdir(root), ['encrypted']);
        await rm(archive);
        await encryptArchive(Readable.from([]), archive, key);
        await decryptArchive(archive, output, key);
        assert.equal((await stat(output)).size, 0);
    } finally {
        key.fill(0);
        await rm(root, {recursive: true, force: true});
    }
});
