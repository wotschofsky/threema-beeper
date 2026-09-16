import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
const root = resolve(import.meta.dirname, '..');
const source = join(root, '.local/sources/bridge-manager');
const commit = '621b50c3c9e395eda28ebe522a1406fdef71c8c9';
const output = join(root, '.local/bin/bbctl-status');
mkdirSync(output, {recursive: true});
const build = mkdtempSync(join(root, '.local/status-proxy-build-'));
const patch = readFileSync(join(root, 'native/bbctl/account-status.patch'));
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const archive = execFileSync('git', ['-C', source, 'archive', commit], {
    maxBuffer: 64 * 1024 * 1024,
});
execFileSync('tar', ['-xf', '-', '-C', build], {input: archive});
execFileSync('patch', ['-p1', '--batch'], {cwd: build, input: patch});
const dependencyPins = JSON.parse(readFileSync(join(root, 'native/bbctl/dependencies.json'), 'utf8'));
const dependencyPatch = readFileSync(join(root, 'native/bbctl/dependencies.patch'));
assert.equal(hash(dependencyPatch), dependencyPins.patchSha256);
for (const file of ['go.mod', 'go.sum'])
    assert.equal(hash(readFileSync(join(build, file))), dependencyPins.originalFiles[file]);
execFileSync('patch', ['-p1', '--batch', '--fuzz=0'], {cwd: build, input: dependencyPatch});
for (const file of ['go.mod', 'go.sum'])
    assert.equal(hash(readFileSync(join(build, file))), dependencyPins.patchedFiles[file]);
const goVersion = execFileSync('go', ['version'], {encoding: 'utf8'}).trim();
assert.equal(goVersion.split(' ')[2], dependencyPins.goVersion, 'Review a changed Go compiler');
assert(readFileSync(join(build, 'cmd/bbctl/proxy.go'), 'utf8').includes('Name: "bridge-status"'));
assert(
    readFileSync(join(build, 'cmd/bbctl/proxy_status_test.go'), 'utf8').includes(
        'TestLocalBridgeStatus',
    ),
);
assert(
    readFileSync(join(build, 'cmd/bbctl/proxy_spool.go'), 'utf8').includes('openTransactionSpool'),
);
const env = {
    ...process.env,
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    GOPATH: process.env.GOPATH ?? join(tmpdir(), 'threema-go'),
    GOCACHE: process.env.GOCACHE ?? join(tmpdir(), 'threema-go-build'),
    CGO_ENABLED: '0',
};
for (const [module, version] of Object.entries(dependencyPins.modules)) {
    assert.equal(execFileSync('go', ['list', '-mod=readonly', '-m', '-f', '{{.Version}}', module],
        {cwd: build, env, encoding: 'utf8'}).trim(), version);
}
const testReport = execFileSync('go', ['test', '-mod=readonly', '-count=1', '-json', './cmd/bbctl', '-run', '^TestLocalBridgeStatus'], {
    cwd: build,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
});
const passed = new Set(testReport.trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.Action === 'pass' && event.Test).map(event => event.Test));
const requiredTests = ['TestLocalBridgeStatus', 'TestLocalBridgeStatusNoRedirect',
    'TestLocalBridgeStatusTransactionFailureClosesWithoutAcknowledgement',
    'TestLocalBridgeStatusSpoolSurvivesRestartAndLostLocalResponse'];
for (const name of requiredTests) assert(passed.has(name), 'Required proxy test did not pass: ' + name);
writeFileSync(join(output, 'proxy-tests.jsonl'), testReport);
const assets = [];
for (const architecture of ['amd64', 'arm64']) {
    const name = 'bbctl-linux-' + architecture;
    execFileSync(
        'go',
        ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', join(output, name), './cmd/bbctl'],
        {cwd: build, env: {...env, GOOS: 'linux', GOARCH: architecture}, stdio: 'inherit'},
    );
    const bytes = readFileSync(join(output, name));
    assets.push({name, architecture, sha256: hash(bytes), size: bytes.length});
}
assert.equal(assets.length, 2);
writeFileSync(
    join(output, 'manifest.json'),
    JSON.stringify(
        {
            schemaVersion: 1,
            commit,
            patchSha256: hash(patch),
            dependencyPatchSha256: hash(dependencyPatch),
            dependencyPins,
            tests: {passed: requiredTests, reportSha256: hash(Buffer.from(testReport))},
            sourceArchiveSha256: hash(archive),
            go: goVersion,
            assets,
        },
        null,
        2,
    ) + '\n',
);
console.log('Status-reporting Linux proxies built for amd64 and arm64.');
