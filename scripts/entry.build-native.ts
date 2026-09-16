import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

assert.equal(process.versions.node.split('.')[0], '24', 'Use the Node 24 executable');
const root = fileURLToPath(new URL('../', import.meta.url));
const desktopRequire = createRequire(
    join(root, '.local/sources/threema-desktop/apps/desktop/package.json'),
);
const rebuildRequire = createRequire(desktopRequire.resolve('@electron/rebuild'));
const nodeGyp = rebuildRequire.resolve('node-gyp/bin/node-gyp.js');

for (const dependency of ['better-sqlcipher', 'argon2']) {
    const dependencyRoot = dirname(desktopRequire.resolve(`${dependency}/package.json`));
    // Use Node's ABI, not electron-rebuild. Never rely on the shell's node binary.
    execFileSync(process.execPath, [nodeGyp, 'rebuild', '--release', '-j', '4'], {
        cwd: dependencyRoot,
        stdio: 'inherit',
    });
}

// --ignore-scripts also skips the git dependency's declaration-generation step.
// Generate declarations from its original JSDoc, without editing dependency code.
const declarations = resolve(root, '.local/argon2-declarations');
mkdirSync(declarations, {recursive: true});
execFileSync(
    process.execPath,
    [
        join(root, '.local/sources/threema-desktop/node_modules/typescript/bin/tsc'),
        '--allowJs',
        '--declaration',
        '--emitDeclarationOnly',
        '--skipLibCheck',
        '--target',
        'es2023',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--types',
        'node',
        '--typeRoots',
        join(root, '.local/sources/threema-desktop/apps/desktop/node_modules/@types'),
        '--outDir',
        declarations,
        desktopRequire.resolve('argon2'),
    ],
    {cwd: root, stdio: 'inherit'},
);
copyFileSync(
    join(declarations, 'argon2.d.cts'),
    join(dirname(desktopRequire.resolve('argon2')), 'argon2.d.cts'),
);
