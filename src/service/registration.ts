import {matrixEndpoint} from './matrix-endpoint.ts';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {parseDocument} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';
import {AppServiceRegistration} from '../../.local/sources/matrix-appservice-bridge/lib/index.js';
import type {ServiceConfig} from './config.ts';

function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0020]/.test(value))
        throw new Error('Invalid registration value');
    return value;
}
/** Local registration is credential-bearing. Never include parsed values or YAML in diagnostics. */
export function parseRegistration(
    source: string,
    config: Pick<ServiceConfig, 'owner' | 'matrix'>,
): {
    registration: AppServiceRegistration;
    domain: string;
    botUserId: string;
} {
    try {
        if (Buffer.byteLength(source) > 65536) throw new Error();
        const doc = parseDocument(source, {uniqueKeys: true, strict: true});
        if (doc.errors.length || doc.warnings.length) throw new Error();
        let value = doc.toJS({maxAliasCount: 0}) as Record<string, unknown>;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        // bbctl --json returns metadata alongside the nested credential-bearing registration.
        // Check that metadata before adapting its WebSocket URL for the local HTTP listener.
        if (Object.hasOwn(value, 'registration')) {
            if (
                value.your_user_id !== config.owner ||
                value.homeserver_domain !== config.matrix.domain ||
                typeof value.homeserver_url !== 'string'
            )
                throw new Error();
            if (matrixEndpoint(value.homeserver_url, config.owner) !== config.matrix.homeserver)
                throw new Error();
            const nested = value.registration;
            if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw new Error();
            value = {...nested} as Record<string, unknown>;
            if (value.url === null || value.url === '' || value.url === 'websocket')
                value.url = `http://${config.matrix.listen}:${config.matrix.port}`;
        }
        const id = text(value.id, 255),
            asToken = text(value.as_token, 4096),
            hsToken = text(value.hs_token, 4096);
        if (asToken === hsToken) throw new Error();
        const sender = text(value.sender_localpart, 255);
        if (!/^[a-z0-9._=\/-]+$/.test(sender)) throw new Error();
        const url = new URL(text(value.url, 2048));
        if (
            url.protocol !== 'http:' ||
            url.hostname !== config.matrix.listen ||
            Number(url.port || 80) !== config.matrix.port ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
        )
            throw new Error();
        const domain = config.matrix.domain;
        if (!config.owner.startsWith('@') || !config.owner.includes(':') || !domain)
            throw new Error();
        const botUserId = `@${sender}:${domain}`;
        if (botUserId === config.owner) throw new Error();
        const namespaces = value.namespaces as Record<string, unknown>;
        if (
            !namespaces ||
            typeof namespaces !== 'object' ||
            Array.isArray(namespaces) ||
            Object.keys(namespaces).some((name) => !['users', 'aliases', 'rooms'].includes(name))
        )
            throw new Error();
        const normalized: Record<string, {regex: string; exclusive: boolean}[]> = {};
        for (const kind of ['users', 'aliases', 'rooms']) {
            const rows = namespaces[kind] ?? [];
            if (!Array.isArray(rows) || rows.length > 100) throw new Error();
            normalized[kind] = rows.map((row: unknown) => {
                if (!row || typeof row !== 'object') throw new Error();
                const pattern = row as {regex?: unknown; exclusive?: unknown};
                if (typeof pattern.exclusive !== 'boolean') throw new Error();
                const regex = text(pattern.regex, 1024);
                new RegExp(regex); // Validate syntax before constructing the framework registration.
                return {regex, exclusive: pattern.exclusive};
            });
        }
        if (!normalized.users!.length) throw new Error();
        for (const flag of ['rate_limited', 'de.sorunome.msc2409.push_ephemeral'])
            if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error();
        if (
            value.protocols !== undefined &&
            (!Array.isArray(value.protocols) ||
                value.protocols.length > 100 ||
                value.protocols.some(
                    (protocol) =>
                        typeof protocol !== 'string' || !protocol || protocol.length > 128,
                ))
        )
            throw new Error();
        const registration = AppServiceRegistration.fromObject({
            id,
            'url': url.origin,
            'as_token': asToken,
            'hs_token': hsToken,
            'sender_localpart': sender,
            'namespaces': normalized,
            'rate_limited': value.rate_limited as boolean | undefined,
            'protocols': value.protocols,
            'de.sorunome.msc2409.push_ephemeral': value['de.sorunome.msc2409.push_ephemeral'] as
                | boolean
                | undefined,
        });
        if (!registration) throw new Error();
        registration.getOutput();
        if (registration.isUserMatch(config.owner, true)) throw new Error();
        return {registration, domain, botUserId};
    } catch {
        throw new Error('Invalid appservice registration');
    }
}

export async function readRegistration(config: Pick<ServiceConfig, 'owner' | 'matrix'>) {
    let handle;
    const bytes = Buffer.alloc(65537);
    try {
        handle = await open(
            config.matrix.registrationFile,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.size > 65536 ||
            stat.mode & 0o077 ||
            (process.getuid !== undefined && stat.uid !== process.getuid())
        )
            throw new Error();
        let count = 0;
        while (count < bytes.length) {
            const chunk = await handle.read(bytes, count, bytes.length - count, null);
            if (!chunk.bytesRead) break;
            count += chunk.bytesRead;
        }
        if (count > 65536) throw new Error();
        return parseRegistration(bytes.subarray(0, count).toString('utf8'), config);
    } catch {
        throw new Error('Unable to load private appservice registration');
    } finally {
        bytes.fill(0);
        await handle?.close();
    }
}
