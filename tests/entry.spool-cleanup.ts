import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MediaTransfer} from '../src/media/media-transfer.ts';

await test('startup cleans orphan and completed media spools, preserves pending data and never follows links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-spool-cleanup-'));
    const parent = join(directory, 'media'),
        outside = join(directory, 'outside');
    await mkdir(parent, {mode: 0o700});
    await mkdir(outside, {mode: 0o700});
    await writeFile(join(outside, 'keep'), 'unrelated');
    const key = randomBytes(32),
        filename = join(directory, 'store.sqlite');
    let store = new PortalStore(filename, key);
    try {
        for (const name of ['attachment-PEND01', 'attachment-DONE01', 'attachment-ORPH01']) {
            await mkdir(join(parent, name), {mode: 0o700});
            await writeFile(join(parent, name, 'ciphertext'), 'encrypted fixture', {mode: 0o600});
        }
        await symlink(outside, join(parent, 'attachment-LINK01'));
        await symlink(outside, join(parent, 'attachment-ORPH01', 'nested'));
        await writeFile(join(parent, 'unrelated'), 'preserve');
        await mkdir(join(parent, 'attachment-not-a-spool'));
        store.prepareMediaUpload(
            'pending',
            'fingerprint',
            JSON.stringify({spoolId: 'attachment-PEND01'}),
        );
        store.prepareMediaUpload(
            'done',
            'fingerprint',
            JSON.stringify({spoolId: 'attachment-DONE01'}),
        );
        store.completeMediaUpload('done', 'saved result');
        store.close();
        store = new PortalStore(filename, key);
        const transfer = new MediaTransfer(store, parent);
        await Promise.all([transfer.initialize(), transfer.initialize()]);
        assert.deepEqual((await readdir(parent)).sort(), [
            'attachment-PEND01',
            'attachment-not-a-spool',
            'unrelated',
        ]);
        assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'unrelated');
        assert.equal(
            await readFile(join(parent, 'attachment-PEND01', 'ciphertext'), 'utf8'),
            'encrypted fixture',
        );
        assert.equal(store.mediaUpload('done')!.result, 'saved result');
        // Initialization never reruns while this instance may be preparing an upload.
        await mkdir(join(parent, 'attachment-NEW001'));
        await transfer.initialize();
        assert.ok((await readdir(parent)).includes('attachment-NEW001'));
        // A malformed pending reference prevents all cleanup, even of a valid orphan.
        store.prepareMediaUpload('bad', 'fingerprint', JSON.stringify({spoolId: '../outside'}));
        await assert.rejects(
            async () => new MediaTransfer(store, parent).initialize(),
            /Invalid pending/,
        );
        assert.ok((await readdir(parent)).includes('attachment-NEW001'));
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('startup refuses a public directory or symlink parent without deleting files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-spool-permissions-'));
    const key = randomBytes(32),
        store = new PortalStore(join(directory, 'store.sqlite'), key);
    const parent = join(directory, 'media');
    try {
        await mkdir(parent, {mode: 0o700});
        await mkdir(join(parent, 'attachment-ORPH01'));
        await chmod(parent, 0o755);
        await assert.rejects(new MediaTransfer(store, parent).initialize(), /private directory/);
        await chmod(parent, 0o700);
        const link = join(directory, 'link');
        await symlink(parent, link);
        await assert.rejects(new MediaTransfer(store, link).initialize(), /private directory/);
        assert.deepEqual(await readdir(parent), ['attachment-ORPH01']);
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
