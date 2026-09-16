import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, readdir, symlink, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanupOutboundAttachmentSpools} from '../src/media/spool-cleanup.ts';
await test('outbound crash cleanup removes only its spool namespace without following links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'outbound-cleanup-'));
    try {
        const spool = join(directory, 'spool'),
            outside = join(directory, 'outside');
        await mkdir(spool, {mode: 0o700});
        await mkdir(outside, {mode: 0o700});
        await writeFile(join(outside, 'keep'), 'outside');
        await mkdir(join(spool, 'outbound-attachment-ABC123'));
        await writeFile(join(spool, 'outbound-attachment-ABC123', 'ciphertext'), 'partial');
        await symlink(outside, join(spool, 'outbound-attachment-DEF456'));
        await mkdir(join(spool, 'outbound-attachment-GHI789'));
        await symlink(outside, join(spool, 'outbound-attachment-GHI789', 'nested'));
        await writeFile(join(spool, 'attachment-ABC123'), 'retained inbound');
        await writeFile(join(spool, 'outbound-attachment-unrecognized'), 'unknown');
        await chmod(spool, 0o755);
        await assert.rejects(cleanupOutboundAttachmentSpools(spool), /private/);
        assert.equal((await readdir(spool)).length, 5);
        await chmod(spool, 0o700);
        await cleanupOutboundAttachmentSpools(spool);
        assert.deepEqual((await readdir(spool)).sort(), [
            'attachment-ABC123',
            'outbound-attachment-unrecognized',
        ]);
        assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside');
        await cleanupOutboundAttachmentSpools(spool);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
