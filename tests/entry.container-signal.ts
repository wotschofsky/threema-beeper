import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const architecture = process.argv[2] ?? 'arm64';
assert(['arm64', 'amd64'].includes(architecture), 'Use arm64 or amd64');
const image = `threema-beeper-service:${architecture}`;
const docker = async (...args: string[]): Promise<string> =>
    (await execute('docker', args, {timeout: 15000, maxBuffer: 256 * 1024})).stdout;

await test(
    'service image init forwards shutdown to the whole child process group',
    {timeout: 45000},
    async () => {
        const [metadata] = JSON.parse(await docker('image', 'inspect', image));
        assert.equal(metadata.Architecture, architecture);
        assert.equal(metadata.Config.User, '1000:1000');
        assert.deepEqual(metadata.Config.Entrypoint, [
            '/usr/bin/tini',
            '-g',
            '--',
            'node',
            'src/service/entry.service.ts',
        ]);
        const name = `threema-init-test-${randomUUID()}`;
        const child = `process.on('SIGTERM', () => { console.log('child-stopped'); process.exit(0); }); console.log('child-ready'); setInterval(() => {}, 1000);`;
        const parent = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio: 'inherit'}); process.on('SIGTERM', () => console.log('parent-stopped')); child.on('exit', code => process.exit(code ?? 1));`;
        try {
            await docker(
                'run',
                '-d',
                '--name',
                name,
                '--platform',
                `linux/${architecture}`,
                '--network',
                'none',
                '--read-only',
                '--cap-drop',
                'ALL',
                '--security-opt',
                'no-new-privileges',
                '--entrypoint',
                '/usr/bin/tini',
                image,
                '-g',
                '--',
                'node',
                '-e',
                parent,
            );
            let ready = false;
            for (let attempt = 0; attempt < 50; attempt++) {
                if ((await docker('logs', name)).includes('child-ready')) {
                    ready = true;
                    break;
                }
                await delay(100);
            }
            assert(ready, 'Synthetic child did not start');
            await docker('stop', '--time', '5', name);
            const [container] = JSON.parse(await docker('inspect', name));
            assert.equal(container.State.Running, false);
            assert.equal(container.State.ExitCode, 0, 'Shutdown must not require SIGKILL');
            const output = await docker('logs', name);
            assert.match(output, /parent-stopped/u);
            assert.match(output, /child-stopped/u);
        } finally {
            await docker('rm', '-f', name);
        }
    },
);
