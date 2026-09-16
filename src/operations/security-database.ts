/** A weekly job must use a valid, recently built database, not merely a successful download. */
export function assertFreshSecurityDatabase(value: unknown, now = Date.now()): void {
    const db = value as {valid?: unknown; built?: unknown; schemaVersion?: unknown};
    if (!db || db.valid !== true || typeof db.built !== 'string' ||
        typeof db.schemaVersion !== 'string' || !/^v6\.\d+\.\d+$/.test(db.schemaVersion))
        throw new Error('Invalid scanner database');
    const built = Date.parse(db.built);
    if (!Number.isFinite(now) || !Number.isFinite(built) || built > now + 5 * 60_000 ||
        now - built > 7 * 24 * 60 * 60_000) throw new Error('Scanner database is stale or future-dated');
}
