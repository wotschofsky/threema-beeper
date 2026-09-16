import {createHash} from 'node:crypto';
import {backupCompatibility} from './compatibility.ts';
import {backupProfileBinding} from './profile-binding.ts';
import {constants} from 'node:fs';
import {lstat, realpath, mkdir, readdir, open, rm} from 'node:fs/promises';
import {dirname, join, relative, sep} from 'node:path';
import {ProfileLock} from '../threema/profile-lock.ts';
import type {ServiceConfig} from '../service/config.ts';

async function privateDirectory(path: string) {
    const stat = await lstat(path);
    if (
        !stat.isDirectory() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await realpath(path)) !== path
    )
        throw new Error('Snapshot requires private owned real directories');
}

/** Private plaintext staging only. Caller must encrypt and remove this snapshot after use. */
export async function captureSnapshot(config: ServiceConfig, destination: string): Promise<void> {
    const bridge = join(config.dataDirectory, 'bridge', config.profileId);
    await privateDirectory(config.dataDirectory);
    await privateDirectory(config.profileDirectory);
    await privateDirectory(bridge);
    await privateDirectory(dirname(destination));
    if (destination !== join(dirname(destination), destination.split(sep).at(-1)!))
        throw new Error('Invalid snapshot destination');
    const roots = [config.profileDirectory, bridge];
    for (const source of roots) {
        const path = relative(source, destination);
        if (!path || (!path.startsWith('..' + sep) && path !== '..' && !path.startsWith(sep)))
            throw new Error('Snapshot destination overlaps source');
    }
    const locks: ProfileLock[] = [];
    let created = false;
    try {
        // Match live-service lock owners. A held lock aborts before destination creation.
        locks.push(new ProfileLock(config.profileDirectory));
        locks.push(new ProfileLock(bridge));
        await mkdir(destination, {mode: 0o700});
        created = true;
        const files: {path: string; bytes: number; mode: number; sha256: string}[] = [];
        async function copy(source: string, target: string): Promise<void> {
            const stat = await lstat(source);
            if (stat.isSymbolicLink() || (await realpath(source)) !== source)
                throw new Error('Snapshot cannot follow symlinks');
            if (stat.isDirectory()) {
                await mkdir(join(destination, target), {mode: 0o700});
                for (const name of (await readdir(source)).sort()) {
                    if (
                        name === '.DS_Store' ||
                        /^\.bridge-profile-lock\.sqlite(?:-wal|-shm|-journal)?$/.test(name)
                    )
                        continue;
                    await copy(join(source, name), join(target, name));
                }
                return;
            }
            if (!stat.isFile() || stat.nlink !== 1)
                throw new Error('Snapshot requires regular unlinked files');
            const input = await open(
                source,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
                const before = await input.stat();
                if (before.ino !== stat.ino || before.dev !== stat.dev)
                    throw new Error('Snapshot source changed');
                const output = await open(join(destination, target), 'wx', 0o600);
                try {
                    const hash = createHash('sha256');
                    let bytes = 0;
                    for await (const chunk of input.createReadStream({autoClose: false})) {
                        hash.update(chunk);
                        bytes += chunk.length;
                        await output.writeFile(chunk);
                    }
                    const after = await input.stat();
                    if (
                        bytes !== before.size ||
                        after.size !== before.size ||
                        after.mtimeMs !== before.mtimeMs ||
                        after.ctimeMs !== before.ctimeMs
                    )
                        throw new Error('Snapshot source changed');
                    await output.sync();
                    files.push({
                        path: target,
                        bytes,
                        mode: stat.mode & 0o777,
                        sha256: hash.digest('hex'),
                    });
                } finally {
                    await output.close();
                }
            } finally {
                await input.close();
            }
        }
        await copy(config.profileDirectory, 'profile');
        await copy(bridge, 'bridge');
        await mkdir(join(destination, 'secrets'), {mode: 0o700});
        await copy(config.passwordFile, 'secrets/threema-profile');
        await copy(config.matrix.cryptoKeyFile, 'secrets/matrix-key');
        await copy(config.matrix.registrationFile, 'secrets/registration');
        if (config.proxy) {
            await copy(config.proxy.configFile, 'secrets/proxy-credentials');
            await copy(config.proxy.registrationFile, 'secrets/proxy-registration');
        }
        const manifest = await open(join(destination, 'manifest.json'), 'wx', 0o600);
        try {
            await manifest.writeFile(
                JSON.stringify(
                    {
                        schemaVersion: 2,
                        compatibility: await backupCompatibility(),
                        binding: backupProfileBinding(config),
                        createdAt: new Date().toISOString(),
                        profileId: config.profileId,
                        identity: config.identity,
                        files,
                    },
                    null,
                    2,
                ) + '\n',
            );
            await manifest.sync();
        } finally {
            await manifest.close();
        }
    } catch {
        if (created) await rm(destination, {recursive: true, force: true});
        throw new Error('Unable to capture closed-profile snapshot');
    } finally {
        for (const lock of locks.reverse()) lock.close();
    }
}
