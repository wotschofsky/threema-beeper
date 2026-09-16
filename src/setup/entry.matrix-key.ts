import {resolve} from 'node:path';
import {readServiceConfig} from '../service/config.ts';
import {initializeMatrixKey} from './matrix-key.ts';

if (process.argv.length !== 3) {
    process.stderr.write('Usage: pnpm run init:matrix-key <config.yaml>\n');
    process.exitCode = 2;
} else {
    try {
        initializeMatrixKey(await readServiceConfig(resolve(process.argv[2]!)));
        process.stdout.write(
            'Matrix store key created. Include this private file in your encrypted recovery backup.\n',
        );
    } catch {
        process.stderr.write(
            'Matrix key initialization failed. Use private existing parent directories, a new key path and a fresh bridge profile. Never regenerate a key for existing encrypted data.\n',
        );
        process.exitCode = 1;
    }
}
