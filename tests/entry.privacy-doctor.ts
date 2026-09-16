import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {privacyDoctor} from '../src/service/privacy-doctor.ts';
import {localDoctor} from '../src/service/local-doctor.ts';
import {ProfileLock, ProfileInUseError} from '../src/threema/profile-lock.ts';

await test('privacy doctor checks metadata without exposing credentials and reports unsafe and missing paths', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'privacy-doctor-'));
    try {
        const example = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
        const config = parseServiceConfig(example);
        config.dataDirectory = root;
        config.profileDirectory = join(root, 'profiles', config.profileId);
        config.passwordFile = join(root, 'password');
        config.matrix.cryptoKeyFile = join(root, 'matrix-key');
        config.matrix.registrationFile = join(root, 'registration');
        config.media.temporaryDirectory = join(root, 'runtime/media');
        const bridge = join(root, 'bridge', config.profileId);
        for (const path of [
            config.profileDirectory,
            join(bridge, 'matrix'),
            config.media.temporaryDirectory,
        ])
            await mkdir(path, {recursive: true, mode: 0o700});
        const secret = 'SECRET-CONTENTS-MUST-NEVER-APPEAR';
        for (const path of [
            config.passwordFile,
            config.matrix.cryptoKeyFile,
            config.matrix.registrationFile,
            ...['journal', 'inbox', 'portals', 'outbox'].map((name) =>
                join(bridge, name + '.sqlite'),
            ),
        ])
            await writeFile(path, secret, {mode: 0o600});
        await chmod(config.passwordFile, 0o400);
        await chmod(config.matrix.cryptoKeyFile, 0o400);
        const report = await privacyDoctor(config);
        assert.equal(report.permissionsHealthy, true);
        assert(!JSON.stringify(report).includes(secret));
        assert.equal(report.encryption.verifiedAtRuntime, false);
        assert.equal(await readFile(config.passwordFile, 'utf8'), secret);
        await chmod(config.passwordFile, 0o600);
        assert.equal(
            (await privacyDoctor(config)).permissionsHealthy,
            false,
            'Secrets require mode 0400, matching service unlock',
        );
        await chmod(config.passwordFile, 0o400);
        const wal = join(bridge, 'journal.sqlite-wal');
        await writeFile(wal, secret, {mode: 0o644});
        const unsafeWal = await privacyDoctor(config);
        assert.equal(unsafeWal.permissionsHealthy, false);
        assert.equal(unsafeWal.paths.find((p) => p.role === 'journal-wal')?.reason, 'permissions');
        await rm(wal);
        await chmod(join(root, 'profiles'), 0o755);
        assert.equal((await privacyDoctor(config)).permissionsHealthy, false);
        await chmod(join(root, 'profiles'), 0o700);
        const before = await readdir(root);
        const local = await localDoctor(config);
        assert.equal(local.checks.find((c) => c.name === 'disk')?.status, 'pass');
        assert.equal(local.checks.find((c) => c.name === 'profile-lock')?.status, 'unknown');
        assert.equal(local.healthy, false);
        assert.deepEqual(await readdir(root), before, 'Disk probe must be cleaned up');
        assert(!JSON.stringify(local).includes(secret));
        const lock = new ProfileLock(config.profileDirectory);
        try {
            const held = await localDoctor(config);
            assert.match(
                held.checks.find((c) => c.name === 'profile-lock')!.detail,
                /exclusive lock is held/,
            );
            assert.throws(() => new ProfileLock(config.profileDirectory), ProfileInUseError);
        } finally {
            lock.close();
        }
        const released = await localDoctor(config);
        assert.match(
            released.checks.find((c) => c.name === 'profile-lock')!.detail,
            /no exclusive lock observed/,
        );
        config.proxy = {
            binary: join(root, 'missing-executable'),
            sha256: '0'.repeat(64),
            configFile: config.passwordFile,
            registrationFile: config.matrix.registrationFile,
        };
        assert.equal(
            (await localDoctor(config)).checks.find((c) => c.name === 'proxy-executable')?.status,
            'fail',
        );
        delete config.proxy;
        await chmod(config.passwordFile, 0o644);
        assert.equal(
            (await privacyDoctor(config)).paths.find((p) => p.role === 'profile-password')?.reason,
            'permissions',
        );
        await rm(config.passwordFile);
        await symlink(config.matrix.cryptoKeyFile, config.passwordFile);
        assert.equal(
            (await privacyDoctor(config)).paths.find((p) => p.role === 'profile-password')?.reason,
            'symlink',
        );
        await rm(config.passwordFile);
        assert.equal(
            (await privacyDoctor(config)).paths.find((p) => p.role === 'profile-password')?.status,
            'missing',
        );
        const alias = join(root, 'alias');
        await symlink(join(root, 'profiles'), alias);
        config.profileDirectory = join(alias, config.profileId);
        assert.equal(
            (await privacyDoctor(config)).paths.find((p) => p.role === 'profile')?.reason,
            'symlink',
        );

        const invalid = join(root, 'invalid.yaml');
        await writeFile(invalid, 'bridge: ' + secret);
        const result = spawnSync(
            process.execPath,
            ['src/service/entry.doctor.ts', '--privacy', invalid],
            {encoding: 'utf8'},
        );
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'Unable to inspect privacy configuration.\n');
        const badArgs = spawnSync(process.execPath, ['src/service/entry.doctor.ts'], {
            encoding: 'utf8',
        });
        assert.equal(badArgs.status, 2);
        assert.equal(badArgs.stdout, '');
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});
