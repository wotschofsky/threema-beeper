import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';

const backend: {
    probeProfileDatabase(profile: string): {contacts: number};
    probe(wasm: string, profile: string): Promise<unknown>;
    probeMissingProfile(profile: string): Promise<string>;
    createNodePlatform(): {
        electron: {removeOldProfiles(): void};
        webrtc: {createGroupCallContext(): void};
        media: {generateImageThumbnail(): Promise<unknown>};
    };
} = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);

await test(
    'real headless backend initializes and reports missing profile without Electron',
    {timeout: 15000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-headless-lifecycle-'));
        try {
            await backend.probe(resolve('.local/wasm-web/libthreema_bg.wasm'), directory);
            assert.equal(await backend.probeMissingProfile(directory), 'no-identity');
            assert.deepEqual(backend.probeProfileDatabase(directory), {contacts: 0});
            const platform = backend.createNodePlatform();
            assert.throws(() => platform.electron.removeOldProfiles(), {
                code: 'UNSUPPORTED_HEADLESS_OPERATION',
            });
            assert.throws(() => platform.webrtc.createGroupCallContext(), {
                code: 'UNSUPPORTED_HEADLESS_OPERATION',
            });
            await assert.rejects(platform.media.generateImageThumbnail(), {
                code: 'UNSUPPORTED_HEADLESS_OPERATION',
            });
        } finally {
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
