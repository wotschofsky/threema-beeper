import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = realpathSync(
    join(root, '.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk'),
);
const overlay = join(root, 'integrations/matrix/overlay');
const pin = JSON.parse(readFileSync(join(overlay, 'source.json'), 'utf8')) as {
    package: string;
    version: string;
    files: {file: string; originalSha256: string}[];
};
const installed = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
assert.equal(installed.name, pin.package);
assert.equal(installed.version, pin.version);
const copies = pin.files.map((source) => {
    const destination = join(sdk, source.file);
    const original = readFileSync(destination);
    const replacement = readFileSync(join(overlay, source.file.slice(4)));
    assert.ok(
        original.equals(replacement) ||
            createHash('sha256').update(original).digest('hex') === source.originalSha256,
        'SDK source differs from the pinned original and our overlay; refusing to overwrite',
    );
    return {destination, replacement};
});
for (const {destination, replacement} of copies) {
    writeFileSync(destination, replacement);
}
// Compile the actual SDK source so the runtime and declarations agree.
execFileSync(
    process.execPath,
    [
        join(root, '.local/sources/matrix-appservice-bridge/node_modules/typescript/bin/tsc'),
        '--project',
        join(sdk, 'tsconfig.json'),
        '--types',
        'node,express',
        '--skipLibCheck',
        '--noEmitOnError',
    ],
    {cwd: sdk, stdio: 'inherit'},
);
