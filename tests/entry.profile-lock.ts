import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ProfileLock, ProfileInUseError} from '../src/threema/profile-lock.ts';

if (process.argv[2] === '--child') {
    const lock = new ProfileLock(process.argv[3]!);
    process.send?.('locked');
    process.on('disconnect', () => {
        lock.close();
        process.exit(0);
    });
    setInterval(() => undefined, 1000);
} else {
    await test(
        'profile lock excludes other processes and releases automatically after SIGKILL',
        {timeout: 15000},
        async (context) => {
            const directory = mkdtempSync(join(tmpdir(), 'threema-profile-lock-'));
            const child = fork(fileURLToPath(import.meta.url), ['--child', directory], {
                execPath: process.execPath,
                stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            });
            const exited = once(child, 'exit');
            try {
                await Promise.race([
                    once(child, 'message', {signal: context.signal}),
                    exited.then(() => {
                        throw new Error('Lock owner exited too early');
                    }),
                ]);
                assert.throws(() => new ProfileLock(directory), ProfileInUseError);
                child.kill('SIGKILL');
                await exited;
                const recovered = new ProfileLock(directory);
                assert.throws(() => new ProfileLock(directory), ProfileInUseError);
                recovered.close();
                recovered.close();
                new ProfileLock(directory).close();
            } finally {
                child.kill('SIGKILL');
                await exited;
                rmSync(directory, {recursive: true, force: true});
            }
        },
    );
    await test('profile lock refuses a symlink directory', () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-profile-symlink-'));
        const link = directory + '-link';
        try {
            symlinkSync(directory, link);
            assert.throws(() => new ProfileLock(link), /private real directory/);
        } finally {
            rmSync(link, {force: true});
            rmSync(directory, {recursive: true, force: true});
        }
    });
}
