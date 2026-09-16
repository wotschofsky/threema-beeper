import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
await test('host backup prunes only after success and restarts on backup or retention failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-host-'));
    const bin = join(directory, 'bin'), backups = join(directory, 'backups'), log = join(directory, 'calls');
    try {
        await mkdir(bin); await mkdir(backups);
        await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
        await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_BACKUP_CALLS"
case "$*" in
  'compose ps --status running -q bridge') if [ "\${TEST_BACKUP_FAIL:-}" != stopped ]; then echo synthetic-container; fi;;
  *'entry.backup.ts create'*) [ "\${TEST_BACKUP_FAIL:-}" != create ];;
  *'entry.retention.ts'*) [ "\${TEST_BACKUP_FAIL:-}" != retention ];;
  'compose start bridge') [ "\${TEST_BACKUP_FAIL:-}" != restart ];;
  *'entry.status.ts'*) [ "\${TEST_BACKUP_FAIL:-}" != status ];;
esac
`, {mode: 0o700});
        for (const failure of ['', 'create', 'retention', 'restart', 'status', 'stopped']) {
            await writeFile(log, '');
            const run = promisify(execFile)('/bin/sh', [resolve('deploy/backup.sh')], {env: {
                ...process.env, PATH: bin + ':' + process.env.PATH, BACKUP_DIR: backups,
                BACKUP_KEY: join(directory, 'synthetic-key'), BACKUP_KEEP: '2',
                TEST_BACKUP_CALLS: log, TEST_BACKUP_FAIL: failure,
            }});
            if (failure && failure !== 'stopped') await assert.rejects(run); else await run;
            const calls = (await readFile(log, 'utf8')).trim().split('\n');
            assert(calls.some(line => line.includes('entry.backup.ts create')));
            assert.equal(calls.some(line => line.includes('entry.retention.ts')), failure !== 'create');
            if (failure === 'stopped') assert(!calls.includes('compose start bridge'));
            else assert.equal(calls.at(-2), 'compose start bridge');
            assert(calls.at(-1)?.includes('entry.status.ts /installation/data/maintenance/backup ' +
                (failure && failure !== 'status' && failure !== 'stopped' ? 'failed' : 'success')));
        }
    } finally { await rm(directory, {recursive: true, force: true}); }
});
