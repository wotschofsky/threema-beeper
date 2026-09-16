import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

await test(
    'macOS codec supervisor preserves exits and kills memory/CPU overruns',
    {skip: process.platform !== 'darwin', timeout: 15000},
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mac-media-limits-'));
        const limiter = join(directory, 'limits'),
            probe = join(directory, 'probe');
        const compile = (source: string, output: string) => {
            const result = spawnSync(
                '/usr/bin/cc',
                ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output],
                {encoding: 'utf8'},
            );
            assert.equal(result.status, 0, result.stderr);
        };
        try {
            const source = join(directory, 'probe.c');
            await writeFile(
                source,
                `#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
 if (argc != 2 || getenv("PRIVATE_TEST_MARKER")) return 99;
 if (!strcmp(argv[1], "exit")) return 7;
 if (!strcmp(argv[1], "cpu")) { volatile unsigned long n=0; for (;;) n++; }
 volatile char *bytes=malloc(128*1024*1024); if (!bytes) return 98;
 for (unsigned long i=0;i<128*1024*1024;i+=4096) bytes[i]=1;
 sleep(3); return 97;
}
`,
            );
            compile(resolve('native/media-limits.c'), limiter);
            compile(source, probe);
            const run = (mode: string) =>
                spawnSync(limiter, ['1', String(32 * 1024 * 1024), '1024', probe, mode], {
                    timeout: 7000,
                    env: {...process.env, PRIVATE_TEST_MARKER: 'synthetic'},
                });
            assert.equal(run('exit').status, 7);
            for (const mode of ['memory', 'cpu']) {
                const result = run(mode);
                assert.equal(result.error, undefined);
                assert.ok(
                    result.signal === 'SIGKILL' || result.status === 137 || result.status === 152,
                    `${mode}: ${result.status}/${result.signal}`,
                );
            }
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    },
);
