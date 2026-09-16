import type {AppServiceRegistration} from '../../.local/sources/matrix-appservice-bridge/lib/index.js';

/** Explicit alias namespaces remain authoritative. Some Beeper registrations declare only users. */
export function assertPortalAlias(
    registration: AppServiceRegistration,
    namespace: string,
    domain: string,
    alias: string,
): void {
    if (registration.isAliasMatch(alias, true)) return;
    if ((registration.getOutput().namespaces?.aliases?.length ?? 0) > 0)
        throw new Error('Portal alias is outside the registered namespace');
    const prefix = `#${namespace}_`,
        suffix = `:${domain}`;
    if (
        !alias.startsWith(prefix) ||
        !alias.endsWith(suffix) ||
        !/^(?:management_)?[a-f0-9]{40}$/.test(alias.slice(prefix.length, -suffix.length))
    )
        throw new Error('Portal alias is outside the configured namespace');
    // No exclusivity is claimed here. Resolved rooms still require ownership/encryption verification.
}
