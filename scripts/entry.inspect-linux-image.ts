import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {verifyContextIntegrity} from './linux-context-integrity.ts';

const [context, architecture, candidateImage] = process.argv.slice(2);
assert(
    context && ['arm64', 'amd64'].includes(architecture!) && [4, 5].includes(process.argv.length),
    'Usage: node scripts/entry.inspect-linux-image.ts <context> <arm64|amd64> [image]',
);
const inputSha256 = verifyContextIntegrity(context);
const image = candidateImage ?? `threema-beeper-service:${architecture}`;
const docker = (...args: string[]): string =>
    execFileSync('docker', args, {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
const [metadata] = JSON.parse(docker('image', 'inspect', image));
assert.equal(metadata.Architecture, architecture);
assert.equal(metadata.Config.User, '1000:1000');
assert.deepEqual(metadata.Config.Entrypoint, [
    '/usr/bin/tini',
    '-g',
    '--',
    'node',
    'src/service/entry.service.ts',
]);
// Run by immutable local image ID, not by a tag which could change during inspection.
const probe = String.raw`
const assert = require('node:assert/strict');
const {readFileSync, readdirSync, existsSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {join} = require('node:path');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = JSON.parse(readFileSync('native-build.json'));
const context = JSON.parse(readFileSync('context-integrity.json'));
const artifacts = ['better-sqlcipher', 'argon2'].map(name => {
    const pkg = manifest.packages.find(pkg => pkg.name === name);
    const filename = name === 'argon2' ? 'argon2.node' : 'better_sqlcipher.node';
    assert.deepEqual(readdirSync(join(pkg.path, 'build/Release')), [filename], 'Native build intermediates remain');
    return join(pkg.path, 'build/Release', filename);
});
const crypto = manifest.packages.find(pkg => pkg.name === '@matrix-org/matrix-sdk-crypto-nodejs');
artifacts.push(join(crypto.path, 'matrix-sdk-crypto.linux-' + process.arch + '-gnu.node'));
const matrixArtifacts = JSON.parse(readFileSync('matrix-native-artifacts.json'));
const matrixArtifact = matrixArtifacts.find(item => item.architecture === (process.arch === 'x64' ? 'amd64' : process.arch));
assert.equal(matrixArtifact.origin, 'local-source-build');
assert.equal(hash(artifacts[2]), matrixArtifact.sha256, 'Matrix source-built addon hash mismatch');
assert(!existsSync('.artifacts'), 'Duplicate staging artifacts remain');
assert.equal(JSON.parse(readFileSync('node_modules/tar/package.json')).version, '7.5.21');
assert(Array.isArray(manifest.buildOnlyPackagePaths));
for (const path of manifest.buildOnlyPackagePaths) {
    assert(!existsSync(path), 'Build-only dependency remains: ' + path);
}
for (const path of ['/usr/local/lib/node_modules/npm', '/usr/local/bin/npm', '/usr/local/bin/npx']) {
    assert(!existsSync(path), 'Build-only npm installation remains: ' + path);
}
assert.deepEqual(readdirSync(crypto.path).filter(path => path.endsWith('.node')),
    ['matrix-sdk-crypto.linux-' + process.arch + '-gnu.node']);
const binaries = artifacts.map(path => {
    const libraries = execFileSync('ldd', [path], {encoding: 'utf8'});
    assert(!libraries.includes('not found'), 'Missing native shared library');
    return {path, sha256: hash(path), libraries};
});
const pins = JSON.parse(readFileSync('status-proxy-manifest.json'));
const bbctlSha256 = hash('/usr/local/bin/bbctl');
const pin = pins.assets.find(asset => asset.name === 'bbctl-linux-' + (process.arch === 'x64' ? 'amd64' : process.arch));
assert.equal(bbctlSha256, pin.sha256);
assert.equal(process.getuid(), 1000);
const packages = execFileSync('dpkg-query', ['-W', '-f=' + '$' + '{Package}\t' + '$' + '{Version}\n'], {encoding: 'utf8'});
assert.equal(process.version, 'v24.21.0');
const frameworkRequire = require('node:module').createRequire(join(process.cwd(),
    '.local/sources/matrix-appservice-bridge/package.json'));
assert.equal(frameworkRequire('js-yaml/package.json').version, '4.3.2');
assert.equal(frameworkRequire('ip-cidr/package.json').version, '4.0.2');
const cidrRequire = require('node:module').createRequire(frameworkRequire.resolve('ip-cidr'));
assert.equal(cidrRequire('ip-address/package.json').version, '10.3.1');
const cidrModule = frameworkRequire('ip-cidr');
const Cidr = cidrModule.__esModule ? cidrModule.default : cidrModule;
assert(new Cidr('192.0.2.0/24').contains('192.0.2.1'));
assert(!existsSync('/probe/node-v24.21.0.tar.xz'), 'Build-only Node source remains');
assert.match(readFileSync('/etc/os-release', 'utf8'), /^VERSION_ID="13"$/m);
for (const [name, minimum] of Object.entries({
    libc6: '2.41-12+deb13u4',
    'perl-base': '5.40.1-6+deb13u1',
    libssl3t64: '3.5.7-1~deb13u2',
})) {
    const version = execFileSync('dpkg-query', ['-W', '-f=' + '$' + '{Version}', name], {encoding: 'utf8'});
    execFileSync('dpkg', ['--compare-versions', version, 'ge', minimum]);
}
// Debian 13's minimal runtime no longer pulls in GnuTLS. If it is introduced
// later, require the fixed version rather than installing it just for this check.
const gnutls = packages.split('\n').find(line => /^libgnutls30(?:t64)?\t/.test(line));
if (gnutls) execFileSync('dpkg', ['--compare-versions', gnutls.split('\t')[1], 'ge', '3.8.9-3+deb13u4']);
console.log(JSON.stringify({inputSha256: context.sha256, node: process.version,
    nodeExecutableSha256: hash(process.execPath),
    nodeDependencies: process.versions,
    nodeSharedOpenSSL: process.config.variables.node_shared_openssl,
    platform: process.platform, architecture: process.arch, uid: process.getuid(),
    bbctlSha256, matrixArtifact, binaries, debianPackages: packages}));
`;
const runtime = JSON.parse(
    docker(
        'run',
        '--rm',
        '--platform',
        `linux/${architecture}`,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--entrypoint',
        'node',
        metadata.Id,
        '-e',
        probe,
    ),
);
assert.equal(runtime.inputSha256, inputSha256, 'Image references a different staged snapshot');
assert.equal(runtime.platform, 'linux');
assert.equal(runtime.architecture, architecture === 'amd64' ? 'x64' : 'arm64');
console.log(
    JSON.stringify(
        {
            schemaVersion: 1,
            imageId: metadata.Id,
            architecture,
            inputSha256,
            runtime,
            scope: 'Local build observation; not signed release provenance',
        },
        null,
        2,
    ),
);
