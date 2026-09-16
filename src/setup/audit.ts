const operations = {
    'link-started': 'link',
    'profile-secret-persisted': 'persist-secret',
    'link-ready': 'link',
    'recovery-acknowledged': 'acknowledge-recovery',
    'link-failed': 'link',
    'link-cancelled': 'cancel-link',
    'link-interrupted': 'stop-link',
    'incomplete-profile-removed': 'remove-incomplete-profile',
} as const;
export type SetupAuditEvent = keyof typeof operations;

/** Deliberately accepts no state payload, path, identity, recovery material or raw error. */
export function setupAuditLog(event: SetupAuditEvent): string {
    if (typeof event !== 'string' || !Object.hasOwn(operations, event))
        throw new Error('Invalid setup audit event');
    return (
        JSON.stringify({
            timestamp: new Date().toISOString(),
            component: 'setup',
            build: 'development',
            profile: 'primary',
            audit: true,
            event,
            operation: operations[event],
            result: event === 'link-failed' ? 'failure' : 'observed',
            error: event === 'link-failed' ? 'link-failed' : null,
        }) + '\n'
    );
}
