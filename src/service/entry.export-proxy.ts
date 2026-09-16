import {resolve} from 'node:path';
import {readServiceConfig} from './config.ts';
import {exportProxyRegistration} from './proxy-registration.ts';

if (process.argv.length !== 4) {
    process.stderr.write('Usage: pnpm run export:proxy <config.yaml> <new-registration.yaml>\n');
    process.exitCode = 2;
} else {
    try {
        const config = await readServiceConfig(resolve(process.argv[2]!));
        await exportProxyRegistration(config, resolve(process.argv[3]!));
        process.stdout.write('Private proxy registration exported.\n');
    } catch {
        process.stderr.write(
            'Proxy registration export failed. Check configuration and private destination; existing files are never replaced.\n',
        );
        process.exitCode = 1;
    }
}
