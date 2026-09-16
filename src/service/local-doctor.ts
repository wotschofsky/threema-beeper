import {constants} from 'node:fs';
import {access, lstat, mkdtemp, open, rm, statfs} from 'node:fs/promises';
import {join} from 'node:path';
import type {ServiceConfig} from './config.ts';
import {privacyDoctor} from './privacy-doctor.ts';
import {verifyExecutable} from './verified-executable.ts';
import {databaseDoctor} from './database-doctor.ts';
import {registrationDoctor} from './registration-doctor.ts';

type Check = {name: string; status: 'pass' | 'fail' | 'unknown'; detail: string};

/** Local probes only. No linked backend, Matrix session or proxy process is started. */
export async function localDoctor(config: ServiceConfig) {
    const privacy = await privacyDoctor(config);
    const checks: Check[] = [
        {
            name: 'permissions',
            status: privacy.permissionsHealthy ? 'pass' : 'fail',
            detail: 'See privacy path observations.',
        },
    ];
    const data = privacy.paths.find((path) => path.role === 'data');
    if (data?.status === 'private') {
        let probe: string | undefined;
        try {
            const disk = await statfs(config.dataDirectory, {bigint: true});
            const available = disk.bavail * disk.bsize;
            await access(config.dataDirectory, constants.W_OK);
            probe = await mkdtemp(join(config.dataDirectory, '.doctor-write-'));
            const file = await open(join(probe, 'probe'), 'wx', 0o600);
            try {
                await file.writeFile('bridge disk probe\n');
                await file.sync();
            } finally {
                await file.close();
            }
            checks.push({
                name: 'disk',
                status: available > 0n ? 'pass' : 'fail',
                detail:
                    'Available bytes: ' +
                    available.toString() +
                    '; small write and fsync succeeded. This is not a capacity forecast.',
            });
        } catch {
            checks.push({
                name: 'disk',
                status: 'fail',
                detail: 'Unable to inspect capacity or complete a private write probe.',
            });
        } finally {
            if (probe) {
                try {
                    await rm(probe, {recursive: true});
                } catch {
                    checks.push({
                        name: 'disk-probe-cleanup',
                        status: 'fail',
                        detail: 'Unable to remove the temporary diagnostic directory.',
                    });
                }
            }
        }
    } else
        checks.push({
            name: 'disk',
            status: 'unknown',
            detail: 'Skipped because the data directory is not private and owned.',
        });

    if (config.proxy) {
        try {
            await verifyExecutable(config.proxy.binary, config.proxy.sha256);
            checks.push({
                name: 'proxy-executable',
                status: 'pass',
                detail: 'Executable permissions and pinned checksum match; process was not started.',
            });
        } catch {
            checks.push({
                name: 'proxy-executable',
                status: 'fail',
                detail: 'Executable permissions or pinned checksum could not be verified.',
            });
        }
    } else
        checks.push({
            name: 'proxy-executable',
            status: 'unknown',
            detail: 'No managed proxy configured.',
        });

    for (const role of ['profile', 'bridge', 'temporary-media']) {
        const path = privacy.paths.find((path) => path.role === role);
        const name = role + '-lock';
        if (path?.status !== 'private') {
            checks.push({
                name,
                status: 'unknown',
                detail: 'Skipped because the directory is not private and owned.',
            });
            continue;
        }
        let database;
        try {
            const filename = join(path.path, '.bridge-profile-lock.sqlite');
            const stat = await lstat(filename);
            if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.mode & 0o022 ||
                (process.getuid && stat.uid !== process.getuid())
            )
                throw new Error();
            const {default: Database} = await import(
                '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js'
            );
            database = new Database(filename, {readonly: true, fileMustExist: true, timeout: 0});
            database.prepare('SELECT singleton FROM lease LIMIT 1').get();
            checks.push({
                name,
                status: 'pass',
                detail: 'Coordination database readable; no exclusive lock observed at this instant.',
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
                checks.push({
                    name,
                    status: 'pass',
                    detail: 'An exclusive lock is held; expected while the corresponding worker is running. Owner identity is not established.',
                });
            else if (code === 'ENOENT')
                checks.push({
                    name,
                    status: 'unknown',
                    detail: 'No coordination database exists yet; no lock was created.',
                });
            else
                checks.push({
                    name,
                    status: 'fail',
                    detail: 'Unable to safely inspect the coordination database.',
                });
        } finally {
            database?.close();
        }
    }
    checks.push(await databaseDoctor(config));
    checks.push(...(await registrationDoctor(config)));
    for (const name of [
        'adapter-compatibility',
        'threema-connection',
        'matrix-appservice',
        'proxy-connection',
        'clock-skew',
        'media-dependencies',
    ])
        checks.push({name, status: 'unknown', detail: 'Not verified by this local diagnostic.'});
    return {
        schemaVersion: 1,
        scope: 'Local diagnostic; no account connections. A private temporary disk probe is created and removed.',
        checks,
        privacy,
        healthy: checks.every((check) => check.status === 'pass'),
        failures: checks.filter((check) => check.status === 'fail').length,
        unverified: checks.filter((check) => check.status === 'unknown').length,
    };
}
