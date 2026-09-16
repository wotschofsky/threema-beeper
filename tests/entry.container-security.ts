import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {parseDocument} from '../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';

const execute = promisify(execFile);
const architecture = process.argv[2] ?? 'arm64';
assert(['arm64', 'amd64'].includes(architecture), 'Use arm64 or amd64');
const docker = async (...args: string[]) =>
    (await execute('docker', args, {timeout: 30000, maxBuffer: 256 * 1024})).stdout;

await test('deployment restrictions apply to Linux parent and child processes', async () => {
    // Compose's JSON encoder omits zero-valued limit fields; YAML preserves them.
    const original = parseDocument(
        await docker('compose', '-f', resolve('deploy/compose.yaml'), 'config', '--format', 'yaml'),
    ).toJS();
    const service = original.services.bridge;
    assert.deepEqual(service.ulimits.core, {soft: 0, hard: 0});
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert(service.security_opt.includes('no-new-privileges:true'));
    assert.equal(service.user, '1000:1000');
    assert(!service.ports?.length);

    const directory = await mkdtemp(join(tmpdir(), 'threema-security-'));
    // Reuse the actual deployment restrictions, replacing only account mounts,
    // networking, startup and healthcheck with a credential-free one-shot probe.
    const probe = String.raw`
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const assert = require('node:assert/strict');
        const limits = fs.readFileSync('/proc/self/limits', 'utf8');
        assert.match(limits, /Max core file size\s+0\s+0\s+bytes/);
        const status = fs.readFileSync('/proc/self/status', 'utf8');
        assert.match(status, /NoNewPrivs:\s+1/);
        assert.match(status, /CapEff:\s+0+\s/);
        assert.equal(process.getuid(), 1000);
        assert.throws(() => fs.writeFileSync('/app/forbidden-probe', 'x'));
        const child = cp.execFileSync(process.execPath, ['-e',
            "process.stdout.write(require('node:fs').readFileSync('/proc/self/limits','utf8'))"
        ], {encoding:'utf8'});
        assert.match(child, /Max core file size\s+0\s+0\s+bytes/);
        const raise = cp.spawnSync('/bin/sh', ['-c', 'ulimit -c unlimited'], {encoding:'utf8'});
        assert.notEqual(raise.status, 0, 'Child must not raise the hard core limit');
        console.log('parent and child core dumps disabled; runtime restrictions verified');
    `;
    const configuration = {
        services: {
            probe: {
                ...service,
                image: `threema-beeper-service:${architecture}`,
                platform: `linux/${architecture}`,
                volumes: [],
                network_mode: 'none',
                networks: undefined,
                restart: 'no',
                healthcheck: {disable: true},
                entrypoint: ['node'],
                command: ['-e', probe],
            },
        },
    };
    const file = join(directory, 'compose.json');
    try {
        await writeFile(file, JSON.stringify(configuration), {mode: 0o600});
        const output = await docker('compose', '-f', file, 'run', '--rm', '--no-deps', 'probe');
        assert.match(output, /runtime restrictions verified/);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
