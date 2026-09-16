import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

// An optional retained installation permits reproducing the pre-fix crash in
// a separate test process. Default execution always exercises the shipped tar.
const packagePath = resolve(process.argv[2] ?? 'node_modules/tar');
const {Header, list} = await import(pathToFileURL(join(packagePath, 'dist/esm/index.js')).href);

await test('asynchronous member selection tolerates a 12,000-segment GNU long path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tar-long-path-'));
    try {
        const longPath = 'a/'.repeat(12_000) + 'file';
        const name = Buffer.from(longPath + '\0');
        const block = (path: string, type: string, size = 0): Buffer => {
            const header = new Header({path, type, size, mode: 0o600});
            header.encode();
            assert(header.block);
            return header.block;
        };
        const bytes = Buffer.concat([
            block('./@LongLink', 'NextFileHasLongPath', name.length),
            name, Buffer.alloc((512 - name.length % 512) % 512),
            block('placeholder', 'File'), block('selected', 'File'), Buffer.alloc(1024),
        ]);
        assert(bytes.length < 32 * 1024, 'Keep the regression fixture bounded');
        const file = join(root, 'long-path.tar');
        await writeFile(file, bytes);
        const all: string[] = [];
        await list({file, strict: true, onReadEntry: (entry: {path: string}) => all.push(entry.path)});
        assert.deepEqual(all, [longPath, 'selected'], 'Verify the long-path record really decoded');
        const selected: string[] = [];
        await list({file, strict: true, onReadEntry: (entry: {path: string}) => selected.push(entry.path)}, ['selected']);
        assert.deepEqual(selected, ['selected']);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});
