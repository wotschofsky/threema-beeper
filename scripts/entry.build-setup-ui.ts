import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const ts: typeof import('../.local/sources/threema-desktop/node_modules/typescript/lib/typescript.js') =
    createRequire(import.meta.url)('../.local/sources/threema-desktop/node_modules/typescript');
const source = readFileSync(root + 'src/setup/web/entry.ts', 'utf8');
const result = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
    fileName: 'entry.ts',
    reportDiagnostics: true,
});
if (result.diagnostics?.length) throw new Error('Setup UI transpilation failed');
mkdirSync(root + '.local/setup-ui', {recursive: true});
writeFileSync(root + '.local/setup-ui/setup.js', result.outputText);
