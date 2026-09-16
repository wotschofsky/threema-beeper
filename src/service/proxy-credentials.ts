import {isAbsolute} from 'node:path';
import {parseDocument} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';
import type {ServiceConfig} from './config.ts';

/** Validate pinned bbctl's explicit prod credential file without returning or logging its token. */
export function validateProxyCredentials(
    source: string,
    config: Pick<ServiceConfig, 'owner' | 'matrix'>,
): void {
    try {
        if (Buffer.byteLength(source) > 1048576) throw new Error();
        // bbctl expects JSON; the YAML parser additionally rejects duplicate object keys.
        JSON.parse(source);
        const document = parseDocument(source, {uniqueKeys: true, strict: true});
        if (document.errors.length || document.warnings.length) throw new Error();
        const value = document.toJS({maxAliasCount: 0});
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof value.device_id !== 'string' ||
            !value.device_id ||
            value.device_id.length > 255
        )
            throw new Error();
        const environments = value.environments;
        if (!environments || typeof environments !== 'object' || Array.isArray(environments))
            throw new Error();
        // loadConfig fills and saves missing data directories for every environment, even unused ones.
        for (const environment of Object.values(environments)) {
            if (environment === null) continue;
            if (!environment || typeof environment !== 'object' || Array.isArray(environment))
                throw new Error();
            const path = (environment as Record<string, unknown>).bridge_data_dir;
            if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/.test(path))
                throw new Error();
        }
        const prod = environments.prod;
        if (
            !prod ||
            typeof prod !== 'object' ||
            Array.isArray(prod) ||
            typeof prod.username !== 'string' ||
            !/^[a-z0-9._=-]{1,255}$/.test(prod.username) ||
            config.owner !== `@${prod.username}:beeper.com` ||
            config.matrix.domain !== 'beeper.local' ||
            ![
                'https://matrix.beeper.com',
                `https://matrix.beeper.com/_hungryserv/${encodeURIComponent(prod.username)}`,
            ].includes(config.matrix.homeserver) ||
            typeof prod.access_token !== 'string' ||
            !/^(?:syt_|bat_)[^\s\u0000-\u001f]{1,8192}$/.test(prod.access_token) ||
            (prod.desktop_data_dir !== undefined && prod.desktop_data_dir !== '')
        )
            throw new Error();
    } catch {
        throw new Error('Invalid private bbctl credentials');
    }
}
