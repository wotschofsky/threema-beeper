const events = {
    'configuration-accepted': {
        operation: 'configure',
        result: 'success',
        error: null,
        audit: false,
    },
    'configuration-rejected': {
        operation: 'configure',
        result: 'failure',
        error: 'invalid-configuration',
        audit: true,
    },
    'service-started': {operation: 'start', result: 'success', error: null, audit: false},
    'service-start-failed': {
        operation: 'start',
        result: 'failure',
        error: 'startup-failed',
        audit: false,
    },
    'service-stopped': {operation: 'stop', result: 'success', error: null, audit: false},
    'service-stop-failed': {
        operation: 'stop',
        result: 'failure',
        error: 'shutdown-failed',
        audit: false,
    },
    'resync-requested': {operation: 'resync', result: 'accepted', error: null, audit: false},
    'resync-unavailable': {operation: 'resync', result: 'unavailable', error: null, audit: false},
} as const;

export type LifecycleEvent = keyof typeof events;

/** Fixed vocabulary only: callers cannot supply errors, identifiers, paths or message text. */
export function lifecycleLog(event: LifecycleEvent, durationMs: number): string {
    if (
        typeof event !== 'string' ||
        !Object.hasOwn(events, event) ||
        !Number.isFinite(durationMs) ||
        durationMs < 0 ||
        durationMs > Number.MAX_SAFE_INTEGER
    )
        throw new Error('Invalid lifecycle log event');
    return (
        JSON.stringify({
            timestamp: new Date().toISOString(),
            component: 'service',
            build: 'development',
            // One profile per process. This is a local alias, never the remote ID or configured path.
            profile: 'primary',
            event,
            ...events[event],
            durationMs: Math.round(durationMs),
        }) + '\n'
    );
}
