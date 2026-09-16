import {randomBytes} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {readServiceConfig} from '../service/config.ts';
import {serializeServiceConfig} from '../service/config-output.ts';
import {linuxServiceConfig} from '../service/linux-config.ts';
import {validateProxyCredentials} from '../service/proxy-credentials.ts';
import {readRegistration} from '../service/registration.ts';
import {createBackup} from './create-backup.ts';
import {restoreBackup} from './restore-backup.ts';
import {adoptWorkspace} from './adopt-workspace.ts';
import {stringify} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';
const [source, credentialsFile, architecture, output] = process.argv.slice(2);
let phase = 'arguments';
let staging: string | undefined;
const key = randomBytes(32);
try {
    if (
        !source ||
        !credentialsFile ||
        !['amd64', 'arm64'].includes(architecture!) ||
        !output ||
        process.argv.length !== 6
    )
        throw Error();
    const destination = resolve(output),
        parent = dirname(destination),
        stat = await lstat(parent);
    if (
        !stat.isDirectory() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await realpath(parent)) !== parent
    )
        throw Error();
    try {
        await lstat(destination);
        throw Error('Destination exists');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    phase = 'configuration';
    const config = await readServiceConfig(resolve(source));
    phase = 'credentials';
    const credentialStat = await lstat(credentialsFile);
    if (
        !credentialStat.isFile() ||
        credentialStat.mode & 0o077 ||
        credentialStat.size > 1048576 ||
        credentialStat.isSymbolicLink()
    )
        throw Error();
    const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
    for (const value of Object.values(credentials.environments))
        if (value) (value as Record<string, unknown>).desktop_data_dir = '';
    validateProxyCredentials(JSON.stringify(credentials), config);
    phase = 'proxy manifest';
    const manifest = JSON.parse(
        await readFile(
            new URL('../../.local/bin/bbctl-status/manifest.json', import.meta.url),
            'utf8',
        ),
    );
    const hash = manifest.assets.find(
        (a: {architecture: string}) => a.architecture === architecture,
    )?.sha256;
    staging = await mkdtemp(join(parent, '.linux-migration-'));
    phase = 'snapshot';
    await createBackup(config, join(staging, 'snapshot.enc'), key);
    phase = 'restore';
    await restoreBackup(join(staging, 'snapshot.enc'), join(staging, 'restored'), key);
    phase = 'adoption';
    const local = await adoptWorkspace(
        join(staging, 'restored'),
        config,
        join(staging, 'installation'),
    );
    phase = 'Linux paths';
    const linux = linuxServiceConfig(local, hash);
    await mkdir(join(local.dataDirectory, 'runtime'), {mode: 0o700});
    await mkdir(local.media.temporaryDirectory, {mode: 0o700});
    for (const value of Object.values(credentials.environments))
        if (value) {
            const environment = value as Record<string, unknown>;
            environment.bridge_data_dir = '/installation/data/proxy';
            environment.desktop_data_dir = '';
        }
    validateProxyCredentials(JSON.stringify(credentials), linux);
    await writeFile(
        join(staging, 'installation/secrets/proxy-credentials'),
        JSON.stringify(credentials) + '\n',
        {mode: 0o600},
    );
    const registration = await readRegistration(local);
    await writeFile(
        join(staging, 'installation/secrets/proxy-registration'),
        stringify(registration.registration.getOutput()),
        {mode: 0o600},
    );
    await writeFile(join(staging, 'installation/bridge.yaml'), serializeServiceConfig(linux), {
        mode: 0o600,
    });
    await rename(join(staging, 'installation'), destination);
    console.log(
        'Private Linux installation prepared. Source was not started or changed. Transfer securely; never run both copies together.',
    );
} catch {
    console.error(
        'Linux preparation failed at ' +
            phase +
            '. Stop the source bridge first, build the status proxy, and use a NEW destination under a private owned directory. Usage: pnpm run prepare:linux-installation <config.yaml> <private-bbctl.json> <amd64|arm64> <new-installation>',
    );
    process.exitCode = 1;
} finally {
    key.fill(0);
    if (staging) await rm(staging, {recursive: true, force: true});
}
