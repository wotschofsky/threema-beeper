import {fileURLToPath} from 'node:url';

import type {ConfigEnv, UserConfig} from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import upstreamConfig from './vite.config';

/** Node-only import probe using the upstream definitions and module resolution. */
export default function headlessSpikeConfig(env: ConfigEnv): UserConfig {
    const config = upstreamConfig(env);
    return {
        ...config,
        plugins: [
            ...(config.plugins ?? []),
            tsconfigPaths({
                projects: [
                    fileURLToPath(new URL('../src/headless/tsconfig.json', import.meta.url)),
                ],
            }),
        ],
        build: {
            ...config.build,
            target: 'node24',
            outDir: '../build/headless-spike',
            lib: {
                entry: fileURLToPath(new URL('../src/headless/entry.probe.ts', import.meta.url)),
                formats: ['cjs'],
            },
            rollupOptions: {
                ...config.build?.rollupOptions,
                output: {entryFileNames: 'entry.probe.cjs'},
            },
        },
    };
}
