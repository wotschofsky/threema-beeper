import {createHash} from 'node:crypto';
import {readFile, readdir, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
/** Source provenance only: no configuration/profile reads, network access or dependency execution. */
export async function sourceVersion() {
    const files: {path: string; sha256: string}[] = [];
    async function add(relative: string) {
        const path = join(projectRoot, relative);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
            throw new Error('Invalid source manifest file');
        files.push({
            path: relative,
            sha256: createHash('sha256')
                .update(await readFile(path))
                .digest('hex'),
        });
    }
    async function walk(relative: string) {
        const entries = await readdir(join(projectRoot, relative), {withFileTypes: true});
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const child = `${relative}/${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error('Source manifest cannot follow links');
            if (entry.isDirectory()) await walk(child);
            else if (/\.(?:ts|json|yaml|yml|md|sh|py|toml|lock|c|h|patch|service|timer)$/.test(entry.name) ||
                /^Dockerfile(?:\.|$)/.test(entry.name)) await add(child);
        }
    }
    for (const path of [
        'package.json',
    'pnpm-lock.yaml',
        'tsconfig.json',
        'config.example.yaml',
        'README.md',
        'LICENSE.txt',
        '.dockerignore',
        '.prettierrc.yml',
    ])
        await add(path);
    for (const directory of ['src', 'scripts', 'integrations', 'deploy/docker', 'docs', 'tests', 'native']) await walk(directory);
    // Never traverse a deployment installation, which can contain account data.
    for (const name of ['.env.example', 'compose.yaml', 'compose.monitoring.yaml', 'backup.sh',
        'heartbeat.sh', 'upstream-check.sh', 'threema-backup.service', 'threema-backup.timer',
        'threema-heartbeat.service', 'threema-heartbeat.timer', 'threema-upstream-check.service',
        'threema-upstream-check.timer']) await add(`deploy/${name}`);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const pins = JSON.parse(await readFile(join(projectRoot, 'docs/SOURCE-PINS.json'), 'utf8'));
    const sdk = JSON.parse(
        await readFile(join(projectRoot, 'integrations/matrix/overlay/source.json'), 'utf8'),
    );
    const bbctl = JSON.parse(await readFile(join(projectRoot, 'docs/BBCTL-PINS.json'), 'utf8'));
    const manifestSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    return {
        schemaVersion: 1,
        project: 'threema-beeper',
        release: null,
        runtime: {
            node: process.versions.node,
            platform: process.platform,
            architecture: process.arch,
        },
        source: {
            sha256: manifestSha256,
            files,
            repositories: pins.repositories,
            matrixSdk: {package: sdk.package, version: sdk.version},
            bbctl,
        },
        verification: {
            upstreamCheckouts: 'not-checked',
            installedDependencies: 'not-checked',
            nativeArtifacts: 'not-checked',
            bbctlExecutable: 'not-checked',
        },
    };
}
