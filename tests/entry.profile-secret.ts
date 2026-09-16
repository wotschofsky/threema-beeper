import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
    generateProfileSecret,
    readProfileSecret,
    saveProfileSecret,
} from '../src/setup/profile-secret.ts';

await test('generated recovery secret is atomically saved, private, and never overwritten', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-secret-'));
    const filename = join(directory, 'profile-secret');
    const secret = generateProfileSecret();
    try {
        saveProfileSecret(filename, secret);
        assert.equal(statSync(filename).mode & 0o777, 0o400);
        // Compare booleans so a failure cannot print secret values in an assertion diff.
        assert.ok(readProfileSecret(filename) === secret);
        assert.throws(() => saveProfileSecret(filename, generateProfileSecret()), {code: 'EEXIST'});
        assert.ok(readProfileSecret(filename) === secret);
        assert.deepEqual(readdirSync(directory), ['profile-secret']);
        symlinkSync(filename, join(directory, 'symlink'));
        assert.throws(() => readProfileSecret(join(directory, 'symlink')));
        chmodSync(filename, 0o644);
        assert.throws(() => readProfileSecret(filename), /mode-0400/);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
