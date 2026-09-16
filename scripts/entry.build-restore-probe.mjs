import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyFileSync} from 'node:fs';
// A separate diagnostic bundle; never replace the running bridge bundle.
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = resolve(root, '.local/sources/threema-desktop/apps/desktop');
copyFileSync(
    resolve(root, 'integrations/threema/overlay/src/headless/restore-probe.ts'),
    resolve(desktop, 'src/headless/restore-probe.ts'),
);
const require = createRequire(resolve(desktop, 'package.json'));
const {build} = await import(require.resolve('vite'));
process.chdir(desktop);
process.env.VITE_MAKE = 'cli,cli,consumer,live';
await build({
    configFile: resolve(desktop, 'config/vite.headless-spike.config.ts'),
    mode: 'production',
    build: {
        outDir: resolve(desktop, 'build/restore-probe'),
        lib: {entry: resolve(desktop, 'src/headless/restore-probe.ts'), formats: ['cjs']},
        rollupOptions: {output: {entryFileNames: 'restore-probe.cjs'}},
    },
});
