import {cp, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, relative, sep} from 'node:path';
import type {ServiceConfig} from '../service/config.ts';
import {verifyRestoreWorkspace} from './verify-workspace.ts';
import {validateProxyCredentials} from '../service/proxy-credentials.ts';
import {readRegistration} from '../service/registration.ts';
import {prepareProxy} from '../service/proxy.ts';
import {databaseDoctor} from '../service/database-doctor.ts';
import {serializeServiceConfig} from '../service/config-output.ts';
import {parseServiceConfig} from '../service/config.ts';
import assert from 'node:assert/strict';
import {synchronizePath, synchronizeTree} from './synchronize-tree.ts';

/** Prepare an isolated installation only; never overwrite, migrate or start an existing service. */
export async function adoptWorkspace(
    workspace: string,
    config: ServiceConfig,
    destination: string,
    checkpoint?: (phase: 'data-synchronized' | 'configuration-published') => void,
): Promise<ServiceConfig> {
    await verifyRestoreWorkspace(workspace, config);
    const parent = dirname(destination),
        stat = await lstat(parent);
    if (
        !stat.isDirectory() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await realpath(parent)) !== parent
    )
        throw new Error('Adoption requires a private owned parent');
    const overlap = relative(workspace, destination);
    if (
        !overlap ||
        (!overlap.startsWith('..' + sep) && overlap !== '..' && !overlap.startsWith(sep))
    )
        throw new Error('Adoption destination overlaps restored workspace');
    await mkdir(destination, {mode: 0o700});
    try {
        const staged = join(destination, '.restore-stage');
        await cp(workspace, staged, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            force: false,
            errorOnExist: true,
        });
        // Reverify copied bytes before using the source workspace's metadata as authority.
        await verifyRestoreWorkspace(staged, config);
        const dataDirectory = join(destination, 'data');
        await mkdir(dataDirectory, {mode: 0o700});
        await mkdir(join(dataDirectory, 'profiles'), {mode: 0o700});
        await mkdir(join(dataDirectory, 'bridge'), {mode: 0o700});
        const profileDirectory = join(dataDirectory, 'profiles', config.profileId);
        await rename(join(staged, 'state/profile'), profileDirectory);
        await rename(join(staged, 'state/bridge'), join(dataDirectory, 'bridge', config.profileId));
        await rename(join(staged, 'state/secrets'), join(destination, 'secrets'));
        const result: ServiceConfig = {
            ...config,
            dataDirectory,
            profileDirectory,
            passwordFile: join(destination, 'secrets/threema-profile'),
            matrix: {
                ...config.matrix,
                cryptoKeyFile: join(destination, 'secrets/matrix-key'),
                registrationFile: join(destination, 'secrets/registration'),
            },
            media: {...config.media, temporaryDirectory: join(dataDirectory, 'runtime/media')},
            ...(config.proxy
                ? {
                      proxy: {
                          ...config.proxy,
                          configFile: join(destination, 'secrets/proxy-credentials'),
                          registrationFile: join(destination, 'secrets/proxy-registration'),
                      },
                  }
                : {}),
        };
        if (result.proxy) {
            const credentials = JSON.parse(await readFile(result.proxy.configFile, 'utf8'));
            for (const environment of Object.values(credentials.environments) as (Record<
                string,
                unknown
            > | null)[])
                if (environment) environment.bridge_data_dir = join(dataDirectory, 'proxy');
            const source = JSON.stringify(credentials);
            validateProxyCredentials(source, result);
            await writeFile(result.proxy.configFile, source + '\n', {mode: 0o600});
        }
        await readRegistration(result);
        if (result.proxy) {
            const supervisor = await prepareProxy(result);
            assert.equal(supervisor.state, 'idle');
            await supervisor.stop();
        }
        // Read-only schema access: adoption must not run store constructors/migrations.
        if ((await databaseDoctor(result, {requireCurrentSchema: true})).status !== 'pass')
            throw new Error();
        await rename(
            join(staged, 'state/manifest.json'),
            join(destination, 'recovery-manifest.json'),
        );
        await rm(staged, {recursive: true});
        const serialized = serializeServiceConfig(result);
        assert.deepEqual(parseServiceConfig(serialized), result);
        const temporaryConfig = join(destination, '.bridge.yaml.pending');
        await writeFile(temporaryConfig, serialized, {flag: 'wx', mode: 0o600});
        await synchronizeTree(destination);
        checkpoint?.('data-synchronized');
        // Startup entrypoint becomes visible only after all installation data is durable.
        await link(temporaryConfig, join(destination, 'bridge.yaml'));
        await rm(temporaryConfig);
        await synchronizePath(destination);
        await synchronizePath(parent);
        checkpoint?.('configuration-published');
        return result;
    } catch {
        await rm(destination, {recursive: true, force: true});
        throw new Error('Restored installation preparation failed');
    }
}
