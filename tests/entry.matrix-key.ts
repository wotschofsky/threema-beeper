import assert from 'node:assert/strict';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {initializeMatrixKey} from '../src/setup/matrix-key.ts';
import {readProfileSecret} from '../src/setup/profile-secret.ts';

await test('Matrix key initialization creates a separate private key and refuses replacement or existing bridge data', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'matrix-key-'));
    try {
        const config = parseServiceConfig(readFileSync('config.example.yaml', 'utf8'));
        config.dataDirectory = root;
        config.passwordFile = join(root, 'threema-secret');
        config.matrix.cryptoKeyFile = join(root, 'matrix-secret');
        initializeMatrixKey(config);
        const first = readProfileSecret(config.matrix.cryptoKeyFile);
        assert.equal(Buffer.from(first, 'base64url').length, 32);
        assert.equal(statSync(config.matrix.cryptoKeyFile).mode & 0o777, 0o400);
        assert.equal(existsSync(config.passwordFile), false);
        assert.throws(() => initializeMatrixKey(config));
        assert(readProfileSecret(config.matrix.cryptoKeyFile) === first);
        rmSync(config.matrix.cryptoKeyFile);
        mkdirSync(join(root, 'bridge'), {mode: 0o700});
        mkdirSync(join(root, 'bridge', config.profileId), {mode: 0o700});
        assert.throws(() => initializeMatrixKey(config));
        assert.equal(existsSync(config.matrix.cryptoKeyFile), false);
        rmSync(join(root, 'bridge'), {recursive: true});
        symlinkSync(root, join(root, 'alias'));
        config.matrix.cryptoKeyFile = join(root, 'alias', 'key');
        assert.throws(() => initializeMatrixKey(config));
        config.matrix.cryptoKeyFile = config.passwordFile;
        assert.throws(() => initializeMatrixKey(config));
        config.matrix.cryptoKeyFile = join(root, 'matrix-secret');
        chmodSync(root, 0o755);
        assert.throws(() => initializeMatrixKey(config));
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
