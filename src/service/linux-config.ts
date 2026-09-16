import type {ServiceConfig} from './config.ts';
/** Fixed container paths; identity, encryption policy and feature flags remain unchanged. */
export function linuxServiceConfig(config: ServiceConfig, proxySha256: string): ServiceConfig {
    if (!/^[0-9a-f]{64}$/.test(proxySha256)) throw Error('Invalid Linux proxy hash');
    const base = '/installation',
        data = base + '/data';
    return {
        ...config,
        dataDirectory: data,
        profileDirectory: data + '/profiles/' + config.profileId,
        passwordFile: base + '/secrets/threema-profile',
        wasmFile: '/app/libthreema_bg.wasm',
        matrix: {
            ...config.matrix,
            listen: '127.0.0.1',
            registrationFile: base + '/secrets/registration',
            cryptoKeyFile: base + '/secrets/matrix-key',
        },
        proxy: {
            binary: '/usr/local/bin/bbctl',
            sha256: proxySha256,
            statusReporting: true,
            configFile: base + '/secrets/proxy-credentials',
            registrationFile: base + '/secrets/proxy-registration',
        },
        media: {
            ...config.media,
            temporaryDirectory: data + '/runtime/media',
            avcEncoder: 'libopenh264',
            tools: {
                limiter: '/usr/local/bin/media-limits',
                ffmpeg: '/usr/bin/ffmpeg',
                jpeg: '/usr/local/bin/jpeg-encode',
                webp: '/usr/local/bin/webp-first-frame',
                avif: '/usr/local/bin/avif-first-frame',
            },
        },
    };
}
