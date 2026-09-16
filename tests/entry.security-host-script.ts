import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
await test('host scan checks pins, freshness, image stability and records failures without starting bridge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scan-host-'));
    const bin = join(directory, 'bin'), tools = join(directory, 'scanner-tools');
    try {
        await mkdir(bin); await mkdir(tools);
        await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
        await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> calls
failure=$(cat failure)
case "$*" in
 'compose ps --all -q bridge') echo synthetic-container;;
 'inspect --format {{.Image}} synthetic-container')
   if [ "$failure" = upgrade ] && [ -f scanned ]; then echo sha256:bbbb; else echo sha256:aaaaaaaa; fi;;
 *entry.security-database.ts*) cat >/dev/null; [ "$failure" != database ];;
 *entry.security-scan-result.ts*failed) [ "$failure" != record ]; ;;
 *entry.security-scan-result.ts*) cat >/dev/null; [ "$failure" != ingest ];;
 *) exit 7;;
esac
`.replace('; ;;', ';;'), {mode: 0o700});
        for (const tool of ['syft', 'grype']) {
            const source = `#!/bin/sh
printf '%s %s\\n' '${tool}' "$*" >> calls
[ -z "\${GRYPE_IGNORE:-}" ] && [ -z "\${SYFT_EXCLUDE:-}" ] || exit 9
failure=$(cat failure)
case "$*" in
 *'db update'*) [ "$failure" != update ];;
 *'db status'*) echo '{}';;
 *sbom:*) [ "$failure" != scan ] || exit 3; touch scanned; echo '{}';;
 scan*) [ "$failure" != inventory ] || exit 3; echo '{}';;
esac
`;
            await writeFile(join(tools, tool), source, {mode: 0o700});
            await writeFile(join(tools, tool + '.sha256'), createHash('sha256').update(source).digest('hex') + '\n');
        }
        for (const failure of ['', 'update', 'database', 'inventory', 'scan', 'upgrade', 'ingest']) {
            await writeFile(join(directory, 'failure'), failure);
            await writeFile(join(directory, 'calls'), '');
            await rm(join(directory, 'scanned'), {force: true});
            const run = promisify(execFile)('/bin/sh', [resolve('deploy/security-check.sh')], {
                cwd: directory, env: {...process.env, PATH: bin + ':' + process.env.PATH,
                    GRYPE_IGNORE: 'must-be-removed', SYFT_EXCLUDE: 'must-be-removed'},
            });
            if (failure) await assert.rejects(run); else await run;
            const calls = await readFile(join(directory, 'calls'), 'utf8');
            assert(!calls.includes('compose start') && !calls.includes('compose stop'));
            assert.equal(calls.includes('/maintenance/security failed'), Boolean(failure));
            if (failure === 'database') assert(!calls.includes('syft scan'));
            if (!failure) assert.equal(await readFile(join(directory, 'maintenance/security-scanner/report.json'), 'utf8'), '{}\n');
        }
        await writeFile(join(tools, 'syft.sha256'), '0'.repeat(64));
        await writeFile(join(directory, 'calls'), '');
        await assert.rejects(promisify(execFile)('/bin/sh', [resolve('deploy/security-check.sh')], {
            cwd: directory, env: {...process.env, PATH: bin + ':' + process.env.PATH},
        }));
        assert(!(await readFile(join(directory, 'calls'), 'utf8')).includes('grype --config'));
    } finally { await rm(directory, {recursive: true, force: true}); }
});
