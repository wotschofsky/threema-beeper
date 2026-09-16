import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {writeContextIntegrity} from '../scripts/linux-context-integrity.ts';

const audit = fileURLToPath(new URL('../scripts/entry.audit-matrix-build.ts', import.meta.url));
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
await test('native build audit binds compiler packages, build success, target, lockfile and output bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'matrix-build-audit-'));
    const context = join(directory, 'context'),
        output = join(directory, 'output');
    mkdirSync(join(context, 'source'), {recursive: true});
    mkdirSync(output);
    const filename = 'matrix-sdk-crypto.linux-arm64-gnu.node';
    const packageId = 'path+file:///source#matrix-sdk-crypto-nodejs@0.0.0';
    const artifact = {
        reason: 'compiler-artifact',
        package_id: packageId,
        target: {kind: ['cdylib']},
        features: ['default', 'bundled-sqlite'],
        profile: {test: false},
        filenames: [
            '/source/target/aarch64-unknown-linux-gnu/release/libmatrix_sdk_crypto_nodejs.so',
        ],
        fresh: false,
    };
    const metadata = {
        version: 1,
        packages: [
            {
                id: packageId,
                name: 'matrix-sdk-crypto-nodejs',
                version: '0.0.0',
                source: null,
                license: 'Apache-2.0',
            },
        ],
    };
    const write = (file: string, value: unknown): void =>
        writeFileSync(join(output, file), JSON.stringify(value));
    const messages = (value: unknown = artifact, success = true): void =>
        writeFileSync(
            join(output, 'cargo-build.jsonl'),
            JSON.stringify(value) +
                '\n' +
                JSON.stringify({reason: 'build-finished', success}) +
                '\n',
        );
    const run = (): any =>
        JSON.parse(
            execFileSync(process.execPath, [audit, context, output, 'arm64'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
    try {
        writeFileSync(join(context, 'source/Cargo.lock'), 'synthetic lock');
        writeFileSync(
            join(context, 'source-pin.json'),
            JSON.stringify({
                sourceCommit: '1'.repeat(40),
                version: '0.6.6',
                assets: [{name: filename, sha256: '2'.repeat(64)}],
            }),
        );
        writeContextIntegrity(context);
        writeFileSync(join(output, filename), 'synthetic native artifact');
        writeFileSync(
            join(output, 'build-hashes.txt'),
            `${hash('synthetic lock')}  Cargo.lock\n${hash('synthetic native artifact')}  /artifacts/${filename}\n`,
        );
        writeFileSync(join(output, 'rustc-version.txt'), 'synthetic compiler');
        writeFileSync(join(output, 'cargo-version.txt'), 'synthetic cargo');
        messages();
        write('cargo-metadata.json', metadata);
        assert.equal(run().observedPackages, 1);
        assert.equal(run().matchesPublishedRelease, false);
        messages(artifact, false);
        assert.throws(run);
        messages();
        write('cargo-metadata.json', {version: 1, packages: []});
        assert.throws(run, /Compiler package missing from resolved metadata/u);
        write('cargo-metadata.json', metadata);
        messages({...artifact, filenames: ['/unexpected/library.so']});
        assert.throws(run);
        messages({...artifact, features: []});
        assert.throws(run);
        messages();
        writeFileSync(join(output, filename), 'changed native artifact');
        assert.throws(run);
        writeFileSync(join(output, filename), 'synthetic native artifact');
        assert.equal(run().nativeSha256, hash('synthetic native artifact'));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
