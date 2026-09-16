import {validateProxyCredentials} from './proxy-credentials.ts';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {parseDocument} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';
import {ProcessSupervisor} from './process-supervisor.ts';
import {verifyExecutable} from './verified-executable.ts';
import {parseRegistration, readRegistration} from './registration.ts';
import type {ServiceConfig} from './config.ts';

/** Prepare the explicit host-supplied proxy; never discover personal bbctl credentials. */
export async function prepareProxy(
    config: ServiceConfig,
    signal?: AbortSignal,
): Promise<ProcessSupervisor> {
    const options = config.proxy;
    if (!options) throw new Error('Proxy configuration is missing');
    try {
        if (!/^sh-[a-z0-9-]+$/.test(config.matrix.namespace)) throw new Error();
        await verifyExecutable(options.binary, options.sha256, signal);
        for (const [filename, maximum] of [
            [options.configFile, 1048576],
            [options.registrationFile, 65536],
        ] as const) {
            if ((await realpath(filename)) !== filename) throw new Error();
            const file = await open(
                filename,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
                const stat = await file.stat();
                if (
                    !stat.isFile() ||
                    stat.mode & 0o077 ||
                    stat.size > maximum ||
                    (process.getuid && stat.uid !== process.getuid())
                )
                    throw new Error();
                if (filename === options.configFile) {
                    const bytes = Buffer.alloc(maximum + 1);
                    try {
                        let length = 0;
                        while (length < bytes.length) {
                            const {bytesRead} = await file.read(
                                bytes,
                                length,
                                bytes.length - length,
                                null,
                            );
                            if (!bytesRead) break;
                            length += bytesRead;
                        }
                        if (length > maximum) throw new Error();
                        validateProxyCredentials(
                            bytes.subarray(0, length).toString('utf8'),
                            config,
                        );
                    } finally {
                        bytes.fill(0);
                    }
                }
            } finally {
                await file.close();
            }
        }
        const original = await readRegistration(config);
        const file = await open(
            options.registrationFile,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const bytes = Buffer.alloc(65537);
        try {
            let length = 0;
            while (length < bytes.length) {
                const result = await file.read(bytes, length, bytes.length - length, null);
                if (!result.bytesRead) break;
                length += result.bytesRead;
            }
            if (length > 65536) throw new Error();
            const source = bytes.subarray(0, length).toString('utf8');
            // bbctl consumes standalone registration YAML, not the JSON metadata envelope.
            const value = parseDocument(source).toJS({maxAliasCount: 0});
            if (!value || typeof value !== 'object' || Object.hasOwn(value, 'registration'))
                throw new Error();
            const local = parseRegistration(source, config);
            if (
                JSON.stringify(local.registration.getOutput()) !==
                JSON.stringify(original.registration.getOutput())
            )
                throw new Error();
        } finally {
            bytes.fill(0);
            await file.close();
        }
        signal?.throwIfAborted();
        return new ProcessSupervisor({
            executable: options.binary,
            sha256: options.sha256,
            args: [
                '--config',
                options.configFile,
                '--env',
                'prod',
                '--color',
                'never',
                'proxy',
                ...(options.statusReporting
                    ? [
                          '--bridge-status',
                          '--transaction-spool',
                          config.dataDirectory +
                              '/bridge/' +
                              config.profileId +
                              '/proxy-transactions',
                      ]
                    : []),
                '--registration',
                options.registrationFile,
            ],
            // bbctl resolves platform config/data defaults during initialization even with --config.
            // Scope those defaults to service storage, never the interactive user's directories.
            env: {
                LANG: 'C',
                LC_ALL: 'C',
                HOME: config.dataDirectory,
                XDG_CONFIG_HOME: config.dataDirectory,
                BBCTL_DATA_HOME: config.dataDirectory,
            },
        });
    } catch {
        throw new Error('Unable to prepare private bbctl proxy');
    }
}
