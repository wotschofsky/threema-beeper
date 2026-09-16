import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins: {repositories: {name: string; url: string; commit: string}[]} = JSON.parse(
    readFileSync(join(root, 'docs/SOURCE-PINS.json'), 'utf8'),
);
for (const pin of pins.repositories) {
    const destination = join(root, '.local/sources', pin.name);
    if (!existsSync(destination)) {
        mkdirSync(dirname(destination), {recursive: true});
        execFileSync('git', ['clone', '--no-checkout', pin.url, destination], {stdio: 'inherit'});
        execFileSync('git', ['-C', destination, 'checkout', '--detach', pin.commit], {
            stdio: 'inherit',
        });
    }
    const commit = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim();
    assert.equal(commit, pin.commit, `Unexpected revision in ${pin.name}; refusing to reset it`);
}
type DesktopPatchSet = {
    patches: {
        file: string;
        originalSha256: string;
        patchedSha256: string;
        before: string;
        after: string;
        occurrences: number;
    }[];
};
const patches = [
    'media-cache.json',
    'send-ids.json',
    'stream-store.json',
    'local-handle.json',
    'read-receipts.json',
    'unsupported-location.json',
].flatMap(
    (name) =>
        (
            JSON.parse(
                readFileSync(join(root, 'integrations/threema/patches', name), 'utf8'),
            ) as DesktopPatchSet
        ).patches,
);
const prepared = patches.map((patch) => {
    const filename = join(root, '.local/sources/threema-desktop/apps/desktop', patch.file);
    const content = readFileSync(filename, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash === patch.patchedSha256) return {filename, content};
    assert.equal(hash, patch.originalSha256, `Upstream patch conflicts: ${patch.file}`);
    assert.equal(content.split(patch.before).length - 1, patch.occurrences);
    const result = content.replaceAll(patch.before, () => patch.after);
    assert.equal(createHash('sha256').update(result).digest('hex'), patch.patchedSha256);
    return {filename, content: result};
});
for (const file of prepared) writeFileSync(file.filename, file.content);
for (const relative of [
    'config/vite.headless-spike.config.ts',
    'src/headless/entry.probe.ts',
    'src/headless/node-factories.ts',
    'src/headless/node-platform.ts',
    'src/headless/node-connection-issue.ts',
    'src/headless/open-profile-probe.ts',
    'src/headless/restore-probe.ts',
    'src/headless/database-probe.ts',
    'src/headless/node-session.ts',
    'src/headless/node-read.ts',
    'src/headless/node-conversations.ts',
    'src/headless/node-watch.ts',
    'src/headless/node-message.ts',
    'src/headless/node-message-types.ts',
    'src/headless/node-history.ts',
    'src/headless/node-history-window.ts',
    'src/headless/node-live-messages.ts',
    'src/headless/node-topology.ts',
    'src/headless/node-directory.ts',
    'src/headless/node-contact.ts',
    'src/headless/node-reaction.ts',
    'src/headless/node-reaction-types.ts',
    'src/headless/node-directory-types.ts',
    'src/headless/node-prepared-files.ts',
    'src/headless/node-prepare-file.ts',
    'src/headless/node-file-stream.ts',
    'src/headless/node-media.ts',
    'src/headless/node-send.ts',
    'src/headless/node-send-prepared-file.ts',
    'src/headless/node-send-prepared-image.ts',
    'src/headless/node-incoming-typing.ts',
    'src/headless/node-mutation-types.ts',
    'src/headless/node-mutation.ts',
    'src/headless/node-profile-picture.ts',
    'src/headless/node-send-prepared-video.ts',
    'src/headless/node-typing-request.ts',
    'src/headless/node-typing.ts',
    'src/headless/tsconfig.json',
]) {
    const source = join(root, 'integrations/threema/overlay', relative);
    const destination = join(root, '.local/sources/threema-desktop/apps/desktop', relative);
    if (existsSync(destination)) {
        assert.ok(
            readFileSync(source).equals(readFileSync(destination)),
            `Overlay differs: ${relative}; reconcile edits before preparing`,
        );
    } else {
        mkdirSync(dirname(destination), {recursive: true});
        copyFileSync(source, destination);
    }
}
copyFileSync(
    join(root, '.dockerignore'),
    join(root, '.local/sources/threema-desktop/.dockerignore'),
);
console.log(
    'Pinned sources and headless overlay ready; dependency installation is a separate step.',
);
