import {matrixEndpoint} from './matrix-endpoint.ts';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute, join, normalize} from 'node:path';
import {parseDocument} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';

export interface ServiceConfig {
    displayName: string;
    profileId: string;
    identity: string;
    owner: string;
    dataDirectory: string;
    profileDirectory: string;
    passwordFile: string;
    wasmFile: string;
    startupTimeoutMs: number;
    matrix: {
        homeserver: string;
        domain: string;
        namespace: string;
        protocolAvatar?: string;
        registrationFile: string;
        cryptoKeyFile: string;
        listen: '127.0.0.1';
        port: number;
    };
    proxy?: {
        binary: string;
        sha256: string;
        configFile: string;
        registrationFile: string;
        statusReporting?: boolean;
    };
    sync: {pageSize: number; maxBufferedEvents: number; periodicMs: number};
    features?: {
        groups: boolean;
        media: boolean;
        reactions?: boolean;
        mutations?: boolean;
        receipts?: boolean;
    };
    media: {
        maximumBytes: number;
        temporaryDirectory: string;
        avcEncoder?: 'libopenh264' | 'libx264';
        tools?: {
            limiter: string;
            ffmpeg: string;
            jpeg: string;
            webp: string;
            avif: string;
        };
    };
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !fields.includes(key))
    )
        throw new Error('Invalid configuration fields');
    return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 4096): string {
    if (
        typeof value !== 'string' ||
        !value ||
        value.length > maximum ||
        /[\u0000-\u001f]/.test(value)
    )
        throw new Error('Invalid configuration string');
    return value;
}
function path(value: unknown): string {
    const result = string(value);
    if (!isAbsolute(result) || result === '/' || normalize(result) !== result)
        throw new Error('Configuration paths must be absolute and normalized');
    return result;
}
function integer(value: unknown, minimum: number, maximum: number): number {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
    )
        throw new Error('Invalid configuration number');
    return value;
}
function duration(value: unknown, maximum: number): number {
    const match = /^(\d+)(ms|s|m|h)$/.exec(string(value, 32));
    if (!match) throw new Error('Invalid configuration duration');
    const scale: Record<string, number> = {ms: 1, s: 1000, m: 60_000, h: 3_600_000};
    return integer(Number(match[1]) * scale[match[2]!]!, 1, maximum);
}
function requireValue(actual: unknown, expected: boolean): void {
    if (actual !== undefined && actual !== expected)
        throw new Error('Unsupported configuration option');
}

/** Parse non-secret YAML only. Error messages never include source snippets or field values. */
export function parseServiceConfig(source: string): ServiceConfig {
    if (Buffer.byteLength(source) > 65536) throw new Error('Configuration exceeds size limit');
    let raw: unknown;
    try {
        const document = parseDocument(source, {uniqueKeys: true, strict: true});
        if (document.errors.length || document.warnings.length) throw new Error();
        raw = document.toJS({maxAliasCount: 0});
    } catch {
        throw new Error('Invalid configuration YAML');
    }
    const root = object(raw, ['bridge']);
    const b = object(root.bridge, [
        'displayname',
        'profile_id',
        'identity',
        'owner',
        'data_dir',
        'password_file',
        'wasm_file',
        'startup_timeout',
        'matrix',
        'sync',
        'media',
        'privacy',
        'features',
        'proxy',
    ]);
    const matrix = object(b.matrix, [
        'homeserver',
        'domain',
        'namespace',
        'protocol_avatar',
        'registration_file',
        'crypto_key_file',
        'listen',
        'port',
        'require_encryption',
    ]);
    const protocolAvatar =
        matrix.protocol_avatar === undefined ? undefined : string(matrix.protocol_avatar, 2048);
    if (protocolAvatar && !/^mxc:\/\/[^/\s]+\/[A-Za-z0-9_-]+$/.test(protocolAvatar))
        throw new Error('Invalid protocol avatar');
    let proxy: ServiceConfig['proxy'];
    if (b.proxy !== undefined) {
        const value = object(b.proxy, [
            'binary',
            'sha256',
            'config_file',
            'registration_file',
            'status_reporting',
        ]);
        if (value.status_reporting !== undefined && typeof value.status_reporting !== 'boolean')
            throw new Error('Invalid proxy status flag');
        const sha256 = string(value.sha256, 64);
        if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid proxy checksum');
        proxy = {
            ...(value.status_reporting === undefined
                ? {}
                : {statusReporting: value.status_reporting as boolean}),
            binary: path(value.binary),
            sha256,
            configFile: path(value.config_file),
            registrationFile: path(value.registration_file),
        };
    }
    const sync = object(b.sync ?? {}, [
        'reconcile_on_connect',
        'page_size',
        'max_buffered_events',
        'periodic_full_reconcile',
    ]);
    const media = object(b.media ?? {}, [
        'auto_download',
        'max_inbound_bytes',
        'temp_dir',
        'tools',
        'avc_encoder',
    ]);
    if (
        media.avc_encoder !== undefined &&
        !['libopenh264', 'libx264'].includes(media.avc_encoder as string)
    )
        throw new Error('Unsupported AVC encoder');
    const privacy = object(b.privacy ?? {}, ['log_remote_ids', 'log_message_metadata']);
    const features = object(b.features ?? {}, [
        'polls',
        'locations',
        'calls',
        'groups',
        'media',
        'reactions',
        'mutations',
        'receipts',
    ]);
    requireValue(matrix.require_encryption, true);
    requireValue(sync.reconcile_on_connect, true);
    requireValue(media.auto_download, true);
    for (const value of Object.values(privacy)) requireValue(value, false);
    for (const name of ['polls', 'locations', 'calls']) requireValue(features[name], false);
    for (const name of ['groups', 'media', 'reactions', 'mutations', 'receipts'])
        if (features[name] !== undefined && typeof features[name] !== 'boolean')
            throw new Error('Invalid feature option');
    const mediaTools = object(media.tools ?? {}, ['limiter', 'ffmpeg', 'jpeg', 'webp', 'avif']);
    const profileId = string(b.profile_id, 64),
        identity = string(b.identity, 8),
        owner = string(b.owner, 1024);
    if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profileId) ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(identity) ||
        !/^@[^\s]+:[^\s]+$/.test(owner)
    )
        throw new Error('Invalid configured identity');
    const dataDirectory = path(b.data_dir ?? '/data');
    const homeserver = string(matrix.homeserver, 2048);
    const domain = string(matrix.domain, 255);
    const namespace = string(matrix.namespace ?? 'threema', 32);
    if (!/^[a-z0-9-]{1,32}$/.test(namespace)) throw new Error('Invalid Matrix namespace');
    const serverName = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(
        domain,
    );
    if (
        !serverName ||
        (serverName[2] && Number(serverName[2]) > 65535) ||
        serverName[1]!
            .split('.')
            .some(
                (label) =>
                    !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'),
            )
    )
        throw new Error('Invalid Matrix domain');

    const endpoint = matrixEndpoint(homeserver, owner);
    if ((matrix.listen ?? '127.0.0.1') !== '127.0.0.1')
        throw new Error('Matrix listener must use loopback');
    const size = /^(\d+)MiB$/.exec(string(media.max_inbound_bytes ?? '100MiB', 32));
    if (!size) throw new Error('Media size must use MiB');
    return {
        displayName: string(b.displayname ?? 'Threema', 128),
        profileId,
        identity,
        owner,
        dataDirectory,
        profileDirectory: join(dataDirectory, 'profiles', profileId),
        passwordFile: path(b.password_file),
        wasmFile: path(b.wasm_file),
        ...(proxy ? {proxy} : {}),
        startupTimeoutMs: duration(b.startup_timeout ?? '90s', 600_000),
        matrix: {
            protocolAvatar,
            homeserver: endpoint,
            domain,
            namespace,
            registrationFile: path(matrix.registration_file),
            cryptoKeyFile: path(matrix.crypto_key_file),
            listen: '127.0.0.1',
            port: integer(matrix.port ?? 29339, 1, 65535),
        },
        sync: {
            pageSize: integer(sync.page_size ?? 500, 1, 500),
            maxBufferedEvents: integer(sync.max_buffered_events ?? 10000, 1, 100000),
            periodicMs: duration(sync.periodic_full_reconcile ?? '24h', 86_400_000),
        },
        features: {
            groups: features.groups === true,
            media: features.media === true,
            ...(features.reactions === undefined ? {} : {reactions: features.reactions === true}),
            ...(features.mutations === undefined ? {} : {mutations: features.mutations === true}),
            ...(features.receipts === undefined ? {} : {receipts: features.receipts === true}),
        },
        media: {
            avcEncoder: (media.avc_encoder ?? 'libopenh264') as 'libopenh264' | 'libx264',
            tools: {
                limiter: path(mediaTools.limiter ?? '/usr/local/bin/media-limits'),
                ffmpeg: path(mediaTools.ffmpeg ?? '/usr/local/bin/ffmpeg'),
                jpeg: path(mediaTools.jpeg ?? '/usr/local/bin/jpeg-encode'),
                webp: path(mediaTools.webp ?? '/usr/local/bin/webp-first-frame'),
                avif: path(mediaTools.avif ?? '/usr/local/bin/avif-first-frame'),
            },
            maximumBytes: integer(Number(size[1]) * 1024 ** 2, 1, 1024 ** 3),
            temporaryDirectory: path(media.temp_dir ?? join(dataDirectory, 'runtime', 'media')),
        },
    };
}

export async function readServiceConfig(filename: string): Promise<ServiceConfig> {
    const handle = await open(path(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid configuration file');
        const bytes = Buffer.alloc(65537);
        let count = 0;
        while (count < bytes.length) {
            const read = await handle.read(bytes, count, bytes.length - count, null);
            if (!read.bytesRead) break;
            count += read.bytesRead;
        }
        if (count > 65536) throw new Error('Configuration exceeds size limit');
        return parseServiceConfig(bytes.subarray(0, count).toString('utf8'));
    } finally {
        await handle.close();
    }
}
