/** Account state for the proxy's bridge_status WebSocket command. Never include credentials. */
export function bridgeStatus(
    owner: string,
    identity: string,
    status: {live: boolean; ready: boolean; syncLive: boolean},
    now = Date.now(),
) {
    const common = {timestamp: Math.floor(now / 1000), ttl: 90, source: 'bridge'};
    return [
        {...common, state_event: status.live ? 'RUNNING' : 'BRIDGE_UNREACHABLE'},
        {
            ...common,
            state_event:
                status.live && status.ready && status.syncLive
                    ? 'CONNECTED'
                    : 'TRANSIENT_DISCONNECT',
            user_id: owner,
            remote_id: identity,
            remote_name: 'Threema',
            remote_profile: {username: identity, name: 'Threema'},
        },
    ] as const;
}
