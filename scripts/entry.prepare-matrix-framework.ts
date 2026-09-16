import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checkout = join(root, '.local/sources/matrix-appservice-bridge');
const patch = JSON.parse(
    readFileSync(join(root, 'integrations/matrix/framework-patches/native-encryption.json'), 'utf8'),
) as {
    commit: string;
    file: string;
    originalSha256: string;
    patchedSha256: string;
    replacements: {from: string; to: string}[];
};
assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], {cwd: checkout, encoding: 'utf8'}).trim(),
    patch.commit,
);
const path = join(checkout, patch.file);
let source = readFileSync(path, 'utf8');
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
if (digest(source) !== patch.patchedSha256) {
    assert.equal(
        digest(source),
        patch.originalSha256,
        'Framework source differs; refusing to overwrite',
    );
    for (const replacement of patch.replacements) {
        assert.equal(source.split(replacement.from).length, 2, 'Patch anchor is not unique');
        source = source.replace(replacement.from, replacement.to);
    }
    assert.equal(digest(source), patch.patchedSha256);
    writeFileSync(path, source);
}
const requestPath = join(checkout, 'src/provisioning/request.ts');
const requestSource = readFileSync(requestPath, 'utf8');
const qsImport = 'import { ParsedQs } from "qs";';
const localParsedQs =
    'type ParsedQs = {[key: string]: undefined | string | string[] | ParsedQs | (string | ParsedQs)[]};';
if (requestSource.includes(qsImport)) {
    writeFileSync(
        requestPath,
        requestSource.replace(qsImport, localParsedQs),
    );
} else {
    assert.ok(requestSource.includes(localParsedQs), 'Unexpected provisioning query type');
}
execFileSync(
    process.execPath,
    [
        join(checkout, 'node_modules/typescript/bin/tsc'),
        '--project',
        join(checkout, 'tsconfig.json'),
        '--noEmitOnError',
    ],
    {cwd: checkout, stdio: 'inherit'},
);
