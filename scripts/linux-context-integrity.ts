import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
    lstatSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

const manifestName = 'context-integrity.json';
type Entry =
    | {path: string; kind: 'file'; bytes: number; mode: number; sha256: string}
    | {path: string; kind: 'link'; target: string};
function inventory(directory: string): Entry[] {
    const root = realpathSync(directory);
    const entries: Entry[] = [];
    function visit(folder: string): void {
        for (const name of readdirSync(folder).sort()) {
            const filename = join(folder, name);
            const path = relative(root, filename).split(sep).join('/');
            if (path === manifestName || name === '.DS_Store') continue;
            const stat = lstatSync(filename);
            if (stat.isSymbolicLink()) {
                const target = readlinkSync(filename);
                assert(!isAbsolute(target), 'Build context contains an absolute symlink');
                const resolved = relative(root, realpathSync(filename));
                assert(
                    resolved !== '..' && !resolved.startsWith(`..${sep}`) && !isAbsolute(resolved),
                    'Build context symlink escapes its root',
                );
                entries.push({path, kind: 'link', target});
            } else if (stat.isDirectory()) {
                visit(filename);
            } else {
                assert(stat.isFile(), 'Build context contains a special file');
                assert(stat.size <= 256 * 1024 * 1024, 'Build context file exceeds limit');
                const bytes = readFileSync(filename);
                entries.push({
                    path,
                    kind: 'file',
                    bytes: bytes.length,
                    mode: stat.mode & 0o777,
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                });
            }
        }
    }
    visit(root);
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function digest(entries: Entry[]): string {
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
export function writeContextIntegrity(directory: string): string {
    const entries = inventory(directory);
    const sha256 = digest(entries);
    writeFileSync(
        join(directory, manifestName),
        JSON.stringify({schemaVersion: 1, sha256, entries}, null, 2) + '\n',
        {flag: 'wx'},
    );
    return sha256;
}
export function verifyContextIntegrity(directory: string): string {
    const filename = join(resolve(directory), manifestName);
    const stat = lstatSync(filename);
    assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024,
        'Invalid context integrity manifest',
    );
    const manifest = JSON.parse(readFileSync(filename, 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    const entries = inventory(directory);
    assert(
        JSON.stringify(entries) === JSON.stringify(manifest.entries),
        'Build context differs from its recorded inputs',
    );
    assert.equal(digest(entries), manifest.sha256, 'Build context digest mismatch');
    return manifest.sha256;
}
