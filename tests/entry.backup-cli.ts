import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

await test('backup CLI creates a protected key without printing it and refuses replacement with fixed errors', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'backup-cli-'));
    const run = (...args: string[]) =>
        spawnSync(process.execPath, ['src/backup/entry.backup.ts', ...args], {
            encoding: 'utf8',
            timeout: 10000,
        });
    try {
        assert.equal(run().status, 2);
        const path = join(root, 'SECRET-PATH');
        const created = run('init-key', path);
        assert.equal(created.status, 0);
        const key = readFileSync(path);
        assert.equal(statSync(path).mode & 0o777, 0o400);
        assert(!created.stdout.includes(key.toString().trim()));
        const rejected = run('init-key', path);
        assert.equal(rejected.status, 1);
        assert(!rejected.stderr.includes('SECRET-PATH'));
        assert(readFileSync(path).equals(key));
        const invalid = run('restore', join(root, 'SECRET-ARCHIVE'), path, join(root, 'output'));
        assert.equal(invalid.status, 1);
        assert(!invalid.stderr.includes('SECRET'));
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
