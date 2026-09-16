import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

assert.equal(process.versions.node.split('.')[0], '24');
const directory = await mkdtemp(join(tmpdir(), 'threema-beeper-headless-probe-'));
try {
    const core: {
        probe(
            wasmFile: string,
            profilePath: string,
        ): Promise<{
            node: string;
            wasmInitialized: boolean;
            hasIdentity: boolean;
        }>;
    } = createRequire(import.meta.url)(
        '../../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
    );
    const result = await core.probe(
        fileURLToPath(new URL('../../.local/wasm-web/libthreema_bg.wasm', import.meta.url)),
        directory,
    );
    assert.equal(result.wasmInitialized, true);
    assert.equal(result.hasIdentity, false);
    console.log(JSON.stringify({...result, linkedProfileTested: false, gatePassed: false}));
} finally {
    await rm(directory, {recursive: true, force: true});
}
