import {mkdir, writeFile, realpath, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {stringify} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';
import {parseServiceConfig} from '../service/config.ts';

try {
    const {values} = parseArgs({
        options: {
            'identity': {type: 'string'},
            'owner': {type: 'string'},
            'homeserver': {type: 'string'},
            'domain': {type: 'string'},
            'data-dir': {type: 'string'},
            'wasm': {type: 'string'},
            'help': {type: 'boolean'},
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            'Usage: pnpm run init:config --identity ABCD1234 --owner @you:server --homeserver https://server/route --data-dir /absolute/new-data [--domain homeserver-domain] [--wasm /absolute/libthreema_bg.wasm]\nCreates a fresh private data layout and bridge.yaml. It does not connect, pair, register, or send messages. Use the Matrix owner and routed homeserver supplied by bbctl.',
        );
    } else {
        if (!values.identity || !values.owner || !values.homeserver || !values['data-dir'])
            throw new Error();
        const requested = resolve(values['data-dir']);
        const data = join(await realpath(dirname(requested)), requested.split('/').at(-1)!);
        const wasm = values.wasm
            ? await realpath(resolve(values.wasm))
            : await realpath(
                  fileURLToPath(
                      new URL('../../.local/wasm-web/libthreema_bg.wasm', import.meta.url),
                  ),
              );
        if (!(await stat(wasm)).isFile()) throw new Error();
        const source = stringify({
            bridge: {
                displayname: 'Threema',
                profile_id: 'primary',
                identity: values.identity,
                owner: values.owner,
                data_dir: data,
                password_file: join(data, 'secrets', 'threema-profile'),
                wasm_file: wasm,
                matrix: {
                    domain: values.domain ?? values.owner.slice(values.owner.indexOf(':') + 1),
                    homeserver: values.homeserver,
                    namespace: 'sh-threema',
                    registration_file: join(data, 'registration.yaml'),
                    crypto_key_file: join(data, 'secrets', 'matrix-key'),
                    listen: '127.0.0.1',
                    port: 29339,
                    require_encryption: true,
                },
            },
        });
        parseServiceConfig(source);
        // Refuse every existing destination, including empty folders and symlinks.
        await mkdir(data, {mode: 0o700});
        for (const child of ['secrets', 'profiles', 'bridge', 'runtime'])
            await mkdir(join(data, child), {mode: 0o700});
        await writeFile(join(data, 'bridge.yaml'), source, {flag: 'wx', mode: 0o600});
        console.log(
            'Created private data layout and bridge.yaml. Next: initialize the Matrix key, provide the bbctl registration, and use setup with this same config. See docs/FIRST-RUN.md.',
        );
    }
} catch {
    console.error(
        'Configuration initialization failed. Check all required arguments, the existing parent directory and WASM file, and use a data directory that does not already exist. Any partially created directory is preserved.',
    );
    process.exitCode = 1;
}
