import {readFile, writeFile} from 'node:fs/promises';
import {readServiceConfig} from './config.ts';
import {serializeServiceConfig} from './config-output.ts';
import {linuxServiceConfig} from './linux-config.ts';
const [source, arch, destination] = process.argv.slice(2);
try {
    if (!source || !['amd64', 'arm64'].includes(arch!) || !destination || process.argv.length !== 5)
        throw Error();
    const manifest = JSON.parse(
        await readFile(
            new URL('../../.local/bin/bbctl-status/manifest.json', import.meta.url),
            'utf8',
        ),
    );
    const asset = manifest.assets.find((a: {architecture: string}) => a.architecture === arch);
    await writeFile(
        destination,
        serializeServiceConfig(linuxServiceConfig(await readServiceConfig(source), asset.sha256)),
        {mode: 0o600, flag: 'wx'},
    );
    console.log(
        'Linux configuration prepared. Copy the existing profile and secrets using the deployment guide before starting.',
    );
} catch {
    console.error(
        'Usage: pnpm run prepare:linux-config <existing-config.yaml> <amd64|arm64> <new-output.yaml>. Build the status proxy first; existing output is never overwritten.',
    );
    process.exitCode = 1;
}
