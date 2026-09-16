import assert from 'node:assert/strict';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {verifyContextIntegrity, writeContextIntegrity} from '../scripts/linux-context-integrity.ts';

await test('context inventory detects changed bytes, modes, missing and additional files', () => {
    const root = mkdtempSync(join(tmpdir(), 'threema-context-'));
    try {
        const source = join(root, 'source.ts');
        writeFileSync(source, 'export const value = 1;', {mode: 0o644});
        mkdirSync(join(root, 'nested'));
        symlinkSync('../source.ts', join(root, 'nested/link'));
        const digest = writeContextIntegrity(root);
        writeFileSync(join(root, '.DS_Store'), 'Finder metadata');
        assert.equal(verifyContextIntegrity(root), digest);
        assert.throws(() => writeContextIntegrity(root), {code: 'EEXIST'});
        writeFileSync(source, 'export const value = 2;');
        assert.throws(() => verifyContextIntegrity(root));
        writeFileSync(source, 'export const value = 1;');
        chmodSync(source, 0o755);
        assert.throws(() => verifyContextIntegrity(root));
        chmodSync(source, 0o644);
        writeFileSync(join(root, 'extra'), 'unexpected');
        assert.throws(() => verifyContextIntegrity(root));
        unlinkSync(join(root, 'extra'));
        unlinkSync(join(root, 'nested/link'));
        assert.throws(() => verifyContextIntegrity(root));
        symlinkSync('../source.ts', join(root, 'nested/link'));
        assert.equal(verifyContextIntegrity(root), digest);
        const manifest = JSON.parse(readFileSync(join(root, 'context-integrity.json'), 'utf8'));
        manifest.sha256 = '0'.repeat(64);
        writeFileSync(join(root, 'context-integrity.json'), JSON.stringify(manifest));
        assert.throws(() => verifyContextIntegrity(root));
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

await test('context inventory rejects host links and broken links', () => {
    const root = mkdtempSync(join(tmpdir(), 'threema-context-link-'));
    try {
        const context = join(root, 'context');
        mkdirSync(context);
        writeFileSync(join(root, 'outside'), 'host data');
        const link = join(context, 'link');
        for (const target of ['../outside', join(root, 'outside'), 'missing']) {
            symlinkSync(target, link);
            assert.throws(() => writeContextIntegrity(context));
            unlinkSync(link);
        }
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
