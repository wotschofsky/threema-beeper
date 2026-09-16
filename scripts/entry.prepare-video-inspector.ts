import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join, resolve, relative} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, '.local/sources/threema-desktop/apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const esbuild = createRequire(require.resolve('vite'))('esbuild');
assert.equal(
    JSON.parse(readFileSync(join(desktop, 'node_modules/mediabunny/package.json'), 'utf8')).version,
    '1.34.4',
);
const result = esbuild.buildSync({
    entryPoints: [join(root, 'src/media/entry.video-inspector.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
});
const bundle = result.outputFiles[0].contents;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inputs = Object.keys(result.metafile.inputs)
    .sort()
    .map((filename) => {
        const path = relative(root, resolve(root, filename));
        assert(!path.startsWith('..'));
        return {path, sha256: sha256(readFileSync(join(root, path)))};
    });
const directory = join(root, '.local/video-inspector');
mkdirSync(directory, {recursive: true});
writeFileSync(join(directory, 'entry.mjs'), bundle);
writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({mediabunnyVersion: '1.34.4', bundleSha256: sha256(bundle), inputs}, null, 2) +
        '\n',
);
console.log(`Built isolated video inspector from ${inputs.length} source inputs`);
