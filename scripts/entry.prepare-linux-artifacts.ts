import assert from 'node:assert/strict';
import {chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';

assert.equal(process.platform, 'linux', 'Run this artifact preparation inside the Linux build');
assert(['arm64', 'x64'].includes(process.arch));
const mode = process.argv[2];
assert(mode === 'native' || mode === 'runtime');
const root = '/probe';
const manifest = JSON.parse(readFileSync(join(root, 'native-build.json'), 'utf8'));
function copy(source: string, destination: string): void {
    mkdirSync(dirname(destination), {recursive: true});
    copyFileSync(source, destination);
}
if (mode === 'native') {
    for (const name of ['better-sqlcipher', 'argon2']) {
        const pkg = manifest.packages.find((entry: {name: string}) => entry.name === name);
        assert(pkg && typeof pkg.path === 'string' && pkg.path.startsWith('.local/sources/'));
        assert(!pkg.path.split('/').includes('..'));
        const path = join(
            pkg.path,
            'build/Release',
            name === 'argon2' ? 'argon2.node' : 'better_sqlcipher.node',
        );
        copy(join(root, path), join('/native', path));
    }
} else {
    assert(Array.isArray(manifest.buildOnlyPackagePaths));
    const buildOnly = new Set<string>(manifest.buildOnlyPackagePaths);
    const isBuildOnly = (path: string): boolean => {
        for (let parent = path; parent !== '.'; parent = dirname(parent)) {
            if (buildOnly.has(parent)) return true;
        }
        return false;
    };
    // Copy only runtime inputs into a fresh stage so discarded assets do not remain
    // in lower layers of the shipped image. Native compilation output is added later.
    cpSync(root, '/runtime', {
        recursive: true,
        verbatimSymlinks: true,
        filter: (filename) => {
            const path = relative(root, filename);
            if (path === 'node-v24.21.0.tar.xz' || path === 'cleanup-hooks.patch') return false;
            if (path === '.artifacts' || path.startsWith('.artifacts/')) return false;
            if (isBuildOnly(path) || isBuildOnly(relative(root, realpathSync(filename)))) return false;
            if (path.endsWith('.node') || path.endsWith('.node.version')) {
                return path.endsWith(`matrix-sdk-crypto.linux-${process.arch}-gnu.node`);
            }
            return true;
        },
    });
    copy(
        join(root, '.artifacts/headless/entry.probe.cjs'),
        '/runtime/.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
    );
    copy(
        join(root, '.artifacts/bbctl', `bbctl-linux-${process.arch === 'x64' ? 'amd64' : 'arm64'}`),
        '/runtime-bin/bbctl',
    );
    chmodSync('/runtime-bin/bbctl', 0o555);
}
