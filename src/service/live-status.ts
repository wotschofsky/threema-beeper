/** Read the running local service only; never open a profile or send an account message. */
export async function liveStatus(options: {
    port: number;
    token: string;
    owner: string;
    identity: string;
}) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
        throw new Error('Invalid status port');
    const response = await fetch(`http://127.0.0.1:${options.port}/_threema/bridge-state`, {
        headers: {Authorization: `Bearer ${options.token}`},
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw new Error('Local status unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) throw new Error('Local status exceeds size limit');
        chunks.push(chunk);
    }
    const states: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(states) || states.length !== 2) throw new Error('Invalid local status');
    const now = Date.now() / 1000;
    for (const state of states) {
        if (
            !state ||
            typeof state !== 'object' ||
            !Number.isSafeInteger(state.timestamp) ||
            !Number.isInteger(state.ttl) ||
            state.ttl < 1 ||
            state.ttl > 90 ||
            state.timestamp > now + 5 ||
            state.timestamp + state.ttl < now
        )
            throw new Error('Invalid or expired local status');
    }
    const [bridge, account] = states;
    if (
        bridge.remote_id !== undefined ||
        account.user_id !== options.owner ||
        account.remote_id !== options.identity ||
        !['RUNNING', 'BRIDGE_UNREACHABLE'].includes(bridge.state_event) ||
        !['CONNECTED', 'TRANSIENT_DISCONNECT'].includes(account.state_event)
    )
        throw new Error('Local status identity or state mismatch');
    return {
        scope: 'Local bridge and Threema connection; does not test Beeper message delivery.',
        bridge: bridge.state_event === 'RUNNING' ? 'running' : 'stopped',
        threema: account.state_event === 'CONNECTED' ? 'connected' : 'disconnected',
        healthy: bridge.state_event === 'RUNNING' && account.state_event === 'CONNECTED',
    };
}
