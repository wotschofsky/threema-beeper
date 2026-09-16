import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
await test('explicit test runner checks the whole file set before executing and preserves failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'explicit-tests-'));
    const runner = resolve('scripts/entry.test-files.ts');
    const run = (...files: string[]) =>
        spawnSync(process.execPath, [runner, ...files], {cwd: directory, encoding: 'utf8'});
    try {
        writeFileSync(
            join(directory, 'present.ts'),
            "import {writeFileSync} from 'node:fs'; writeFileSync('executed', 'yes');\n",
        );
        const missing = run('present.ts', 'absent.ts');
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /Requested test file is missing/);
        assert.equal(existsSync(join(directory, 'executed')), false);
        assert.notEqual(run().status, 0);
        assert.notEqual(run('--watch').status, 0);
        assert.equal(run('present.ts').status, 0);
        assert.equal(existsSync(join(directory, 'executed')), true);
        writeFileSync(
            join(directory, 'failure.ts'),
            "import {test} from 'node:test'; test('intentional failure', () => {throw new Error('fixture');});\n",
        );
        assert.notEqual(run('failure.ts').status, 0);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
