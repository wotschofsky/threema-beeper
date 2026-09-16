import type {ServiceConfig} from './config.ts';

/** JSON is a YAML subset; only non-secret configuration and file references are serialized. */
export function serializeServiceConfig(config: ServiceConfig): string {
    return (
        JSON.stringify(
            {
                bridge: {
                    displayname: config.displayName,
                    profile_id: config.profileId,
                    identity: config.identity,
                    owner: config.owner,
                    data_dir: config.dataDirectory,
                    password_file: config.passwordFile,
                    wasm_file: config.wasmFile,
                    startup_timeout: config.startupTimeoutMs + 'ms',
                    matrix: {
                        homeserver: config.matrix.homeserver,
                        domain: config.matrix.domain,
                        namespace: config.matrix.namespace,
                        protocol_avatar: config.matrix.protocolAvatar,
                        registration_file: config.matrix.registrationFile,
                        crypto_key_file: config.matrix.cryptoKeyFile,
                        listen: config.matrix.listen,
                        port: config.matrix.port,
                        require_encryption: true,
                    },
                    ...(config.proxy
                        ? {
                              proxy: {
                                  binary: config.proxy.binary,
                                  status_reporting: config.proxy.statusReporting,
                                  sha256: config.proxy.sha256,
                                  config_file: config.proxy.configFile,
                                  registration_file: config.proxy.registrationFile,
                              },
                          }
                        : {}),
                    sync: {
                        page_size: config.sync.pageSize,
                        max_buffered_events: config.sync.maxBufferedEvents,
                        periodic_full_reconcile: config.sync.periodicMs + 'ms',
                        reconcile_on_connect: true,
                    },
                    media: {
                        auto_download: true,
                        avc_encoder: config.media.avcEncoder,
                        tools: config.media.tools,
                        max_inbound_bytes: config.media.maximumBytes / 1024 ** 2 + 'MiB',
                        temp_dir: config.media.temporaryDirectory,
                    },
                    privacy: {log_remote_ids: false, log_message_metadata: false},
                    features: {...config.features, polls: false, locations: false, calls: false},
                },
            },
            null,
            2,
        ) + '\n'
    );
}
