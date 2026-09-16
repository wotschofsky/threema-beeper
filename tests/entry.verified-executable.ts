import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, writeFile, chmod, symlink, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {verifyExecutable} from '../src/service/verified-executable.ts';

await test('executable verification checks the pin, permissions, symlinks and cancellation without executing', async () => {
    // A globally writable temp ancestor is intentionally forbidden for executables.
    const directory = await realpath(await mkdtemp(resolve('.local/executable-test-')));
    const file = join(directory, 'fixture');
    const bytes = Buffer.from('synthetic executable bytes, not a runnable program');
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
        await writeFile(file, bytes, {mode: 0o700});
        await verifyExecutable(file, hash);
        await assert.rejects(verifyExecutable(file, '0'.repeat(64)), {
            message: 'Executable verification failed',
        });
        await chmod(file, 0o600);
        await assert.rejects(verifyExecutable(file, hash));
        await chmod(file, 0o777);
        await assert.rejects(verifyExecutable(file, hash));
        await chmod(file, 0o700);
        const link = join(directory, 'link');
        await symlink(file, link);
        await assert.rejects(verifyExecutable(link, hash));
        await chmod(directory, 0o777);
        await assert.rejects(verifyExecutable(file, hash));
        await chmod(directory, 0o700);
        await assert.rejects(verifyExecutable(file, hash, AbortSignal.abort()));
        await writeFile(file, 'changed');
        await assert.rejects(verifyExecutable(file, hash));
        await assert.rejects(verifyExecutable(directory, hash));
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
