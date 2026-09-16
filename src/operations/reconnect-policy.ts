/** Bounded, serializable policy state. Delivery/storage belong to the maintenance notifier. */
export interface ReconnectState {
    schemaVersion: 1;
    connected?: boolean;
    observedAt?: number;
    disconnectedAt?: number;
    stableSince?: number;
    disconnects: number[];
    active: boolean;
    revision: number;
}
export const reconnectWindowMs = 10 * 60_000;
export const reconnectThreshold = 3;
const timestamp = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
export function parseReconnectState(value: unknown): ReconnectState {
    const state = value as ReconnectState;
    if (!state || state.schemaVersion !== 1 || typeof state.active !== 'boolean' ||
        !timestamp(state.revision) || !Array.isArray(state.disconnects) ||
        state.disconnects.length > reconnectThreshold ||
        state.disconnects.some((t, i) => !timestamp(t) || (i > 0 && t < state.disconnects[i - 1]!)) ||
        (state.connected !== undefined && typeof state.connected !== 'boolean') ||
        [state.observedAt, state.disconnectedAt, state.stableSince].some(t => t !== undefined && !timestamp(t)) ||
        (state.connected === true && state.disconnectedAt !== undefined) ||
        (state.connected === false && state.stableSince !== undefined) ||
        (state.connected !== undefined && state.observedAt === undefined) ||
        (state.connected === true && state.stableSince === undefined) ||
        (state.connected === false && state.disconnectedAt === undefined) ||
        [...state.disconnects, state.disconnectedAt, state.stableSince].some(t =>
            t !== undefined && (state.observedAt === undefined || t > state.observedAt)) ||
        (state.active && state.revision === 0)) throw new Error('Invalid reconnect state');
    return {schemaVersion: 1, disconnects: [...state.disconnects], active: state.active, revision: state.revision,
        ...(state.connected !== undefined ? {connected: state.connected} : {}),
        ...(state.observedAt !== undefined ? {observedAt: state.observedAt} : {}),
        ...(state.disconnectedAt !== undefined ? {disconnectedAt: state.disconnectedAt} : {}),
        ...(state.stableSince !== undefined ? {stableSince: state.stableSince} : {})};
}

/** Three distinct losses in ten minutes or ten continuous offline minutes require attention. */
export function observeReconnect(previous: ReconnectState | undefined, connected: boolean, now: number): ReconnectState {
    if (typeof connected !== 'boolean' || !timestamp(now)) throw new Error('Invalid connection observation');
    const state = previous ? parseReconnectState(previous)
        : {schemaVersion: 1 as const, disconnects: [], active: false, revision: 0};
    // Clock rollback must not turn a brief interruption into a long outage or re-arm an active alert.
    if (state.observedAt !== undefined && now < state.observedAt) {
        state.disconnects = [];
        delete state.stableSince;
        delete state.disconnectedAt;
        delete state.connected;
    }
    state.disconnects = state.disconnects.filter(t => now - t <= reconnectWindowMs);
    if (connected) {
        if (state.connected !== true) state.stableSince = now;
        delete state.disconnectedAt;
        if (state.stableSince !== undefined && now - state.stableSince >= reconnectWindowMs) {
            state.active = false;
            state.disconnects = [];
        }
    } else {
        if (state.connected !== false) {
            state.disconnectedAt = now;
            // An initial offline snapshot is not a reconnect; a prolonged initial outage still alerts.
            if (state.connected === true) state.disconnects.push(now);
            state.disconnects = state.disconnects.slice(-reconnectThreshold);
        }
        delete state.stableSince;
    }
    const prolonged = !connected && state.disconnectedAt !== undefined && now - state.disconnectedAt >= reconnectWindowMs;
    if (!state.active && (prolonged || state.disconnects.length >= reconnectThreshold)) {
        if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('Reconnect revision exhausted');
        state.revision++;
        state.active = true;
    }
    state.connected = connected;
    state.observedAt = now;
    return parseReconnectState(state);
}
