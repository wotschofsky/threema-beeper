import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {verifyExecutable} from '../src/service/verified-executable.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(join(root, 'docs/BBCTL-PINS.json'), 'utf8'));
const image = 'debian@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd';
const images: Record<string, string> = {
    arm64: 'debian@sha256:8b5033c95ca60cdffb0e0f4c446e5f714e82d8960a9ef4153c0eaf13e988b0ea',
    amd64: 'debian@sha256:9bb8a3626890e084ab54e888fdd7c4b6d2f119071cd4c5dc5fecb4d73062aa5f',
};
const run = promisify(execFile);
const results = [];
for (const architecture of ['arm64', 'amd64']) {
    const asset = pins.assets.find(
        (value: {name: string}) => value.name === `bbctl-linux-${architecture}`,
    );
    const binary = join(root, '.local/bin/bbctl-v0.15.0', asset.name);
    await verifyExecutable(binary, asset.sha256);
    for (const command of [['--version'], ['proxy', '--help']]) {
        const args = [
            'run',
            '--rm',
            '--platform',
            `linux/${architecture}`,
            '--network',
            'none',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--user',
            '65534:65534',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=16m',
            '--mount',
            `type=bind,src=${binary},dst=/bbctl,readonly`,
            '--env',
            'HOME=/tmp',
            '--env',
            'XDG_CONFIG_HOME=/tmp',
            '--env',
            'BBCTL_DATA_HOME=/tmp',
            images[architecture]!,
            '/bbctl',
            ...command,
        ];
        const {stdout} = await run('docker', args, {timeout: 120000, maxBuffer: 1024 * 1024});
        if (
            command[0] === '--version'
                ? !stdout.startsWith('bbctl version v0.15.0 ')
                : !stdout.includes('--registration')
        )
            throw new Error('Unexpected bbctl smoke output');
        results.push({
            architecture,
            image: images[architecture],
            command,
            sha256: asset.sha256,
            stdout: stdout.trim(),
        });
    }
}
const result = {
    schemaVersion: 1,
    image,
    hostArchitecture: process.arch,
    network: 'none',
    credentialsMounted: false,
    results,
};
await writeFile(
    join(root, '.local/bbctl-smoke-results.json'),
    JSON.stringify(result, null, 2) + '\n',
);
process.stdout.write('bbctl version/help smoke checks passed for Linux arm64 and amd64.\n');
