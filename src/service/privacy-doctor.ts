import {lstat} from 'node:fs/promises';
import {dirname, join, parse} from 'node:path';
import type {ServiceConfig} from './config.ts';

export interface PrivacyPath {
    role: string;
    path: string;
    status: 'private' | 'unsafe' | 'missing' | 'unavailable';
    required: boolean;
    mode?: string;
    ownedByCurrentUser?: boolean;
    reason?: 'symlink' | 'type' | 'permissions' | 'owner';
}

/** Metadata only: never open credentials, databases, locks or media contents. */
async function inspect(
    role: string,
    path: string,
    directory: boolean,
    required = true,
    exactMode?: number,
): Promise<PrivacyPath> {
    const base = {role, path, required};
    try {
        // Reject symlinked ancestors too; inspecting a symlink target would hide
        // an important difference between the configured and effective location.
        const parents: string[] = [];
        for (let parent = dirname(path); parent !== parse(parent).root; parent = dirname(parent))
            parents.unshift(parent);
        for (const parent of parents) {
            const stat = await lstat(parent);
            if (stat.isSymbolicLink()) return {...base, status: 'unsafe', reason: 'symlink'};
            if (!stat.isDirectory()) return {...base, status: 'unsafe', reason: 'type'};
        }
        const stat = await lstat(path);
        const details = {
            ...base,
            mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
            ownedByCurrentUser: process.getuid !== undefined && stat.uid === process.getuid(),
        };
        if (stat.isSymbolicLink()) return {...details, status: 'unsafe', reason: 'symlink'};
        if (directory ? !stat.isDirectory() : !stat.isFile())
            return {...details, status: 'unsafe', reason: 'type'};
        if (stat.mode & 0o077 || (exactMode !== undefined && (stat.mode & 0o777) !== exactMode))
            return {...details, status: 'unsafe', reason: 'permissions'};
        if (!details.ownedByCurrentUser) return {...details, status: 'unsafe', reason: 'owner'};
        return {...details, status: 'private'};
    } catch (error) {
        return {
            ...base,
            status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable',
        };
    }
}

export async function privacyDoctor(config: ServiceConfig) {
    const bridge = join(config.dataDirectory, 'bridge', config.profileId);
    const locations: [string, string, boolean, boolean?, number?][] = [
        ['data', config.dataDirectory, true],
        ['profiles-parent', join(config.dataDirectory, 'profiles'), true],
        ['bridge-parent', join(config.dataDirectory, 'bridge'), true],
        ['runtime-parent', join(config.dataDirectory, 'runtime'), true],
        ['profile', config.profileDirectory, true],
        ['profile-password', config.passwordFile, false, true, 0o400],
        ['matrix-key', config.matrix.cryptoKeyFile, false, true, 0o400],
        ['appservice-registration', config.matrix.registrationFile, false],
        ['bridge', bridge, true],
        ['matrix-crypto', join(bridge, 'matrix'), true],
        ['temporary-media', config.media.temporaryDirectory, true],
    ];
    for (const name of ['journal', 'inbox', 'portals', 'outbox']) {
        const database = join(bridge, name + '.sqlite');
        locations.push([name + '-database', database, false]);
        for (const suffix of ['-wal', '-shm', '-journal'])
            locations.push([name + suffix, database + suffix, false, false]);
    }
    if (config.proxy)
        locations.push(
            ['proxy-credentials', config.proxy.configFile, false],
            ['proxy-registration', config.proxy.registrationFile, false],
        );
    const paths = await Promise.all(
        locations.map(([role, path, directory, required, exactMode]) =>
            inspect(role, path, directory, required, exactMode),
        ),
    );
    return {
        schemaVersion: 1,
        scope: 'Local configuration and filesystem metadata only; no database unlock, account connection or live encryption verification.',
        paths,
        permissionsHealthy: paths.every(
            (path) => path.status === 'private' || (!path.required && path.status === 'missing'),
        ),
        encryption: {
            matrixMessages: 'required',
            bridgeDatabases: 'SQLCipher configured',
            matrixCryptoStore: 'passphrase protection configured',
            secretFiles: 'plaintext unlock material protected by filesystem permissions',
            verifiedAtRuntime: false,
        },
        telemetry: {
            sdkLogger: 'suppressed by service entrypoint',
            remoteIdsInLogs: false,
            messageMetadataInLogs: false,
            upstreamTelemetry: 'not verified by this command',
        },
        retention: {
            databases: 'no automatic retention limit configured',
            temporaryMedia:
                'encrypted transfer spools; lifecycle cleanup, no configurable time limit',
            logs: 'external stdout/stderr collector policy; not configured by bridge',
            backups: 'not configured by bridge',
        },
    };
}
