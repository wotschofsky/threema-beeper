export interface MetricsSnapshot {
    live: boolean;
    ready: boolean;
    syncLive: boolean;
    /** Omit for an externally managed proxy; unknown is not the same as down. */
    proxyUp?: boolean;
    uptimeSeconds: number;
    residentBytes: number;
    queues?: {
        journal: number;
        transactions: number;
        events: number;
        prepared: number;
        dispatching: number;
        awaitingEcho: number;
        uncertain: number;
    };
    reactionQueues?: {
        prepared: number;
        dispatching: number;
        uncertain: number;
        failureNotices: number;
        retirements: number;
    };
    mediaQueues?: {
        prepared: number;
        dispatching: number;
        awaitingEcho: number;
        uncertain: number;
    };
}

/** A fixed metric vocabulary prevents identifiers or arbitrary error strings becoming labels. */
export function renderMetrics(snapshot: MetricsSnapshot): string {
    const boolean = (value: boolean) => {
        if (typeof value !== 'boolean') throw new Error('Invalid metric');
        return value ? 1 : 0;
    };
    const number = (value: number) => {
        if (!Number.isFinite(value) || value < 0) throw new Error('Invalid metric');
        return value;
    };
    const values: [string, string, number][] = [
        ['bridge_process_up', 'Bridge service lifecycle is active.', boolean(snapshot.live)],
        ['bridge_ready', 'Bridge readiness checks pass.', boolean(snapshot.ready)],
        [
            'bridge_sync_live',
            'Profile reconciliation is in live state.',
            boolean(snapshot.syncLive),
        ],
        [
            'process_uptime_seconds',
            'Node process uptime in seconds.',
            number(snapshot.uptimeSeconds),
        ],
        [
            'process_resident_memory_bytes',
            'Node process resident memory in bytes.',
            number(snapshot.residentBytes),
        ],
    ];
    if (snapshot.proxyUp !== undefined)
        values.push([
            'bbctl_proxy_up',
            'Supervised bbctl process is running; not a WebSocket connectivity check.',
            boolean(snapshot.proxyUp),
        ]);
    if (snapshot.queues) {
        for (const [key, name] of [
            ['journal', 'bridge_journal_pending'],
            ['transactions', 'bridge_transactions_pending'],
            ['events', 'bridge_inbox_events_pending'],
            ['prepared', 'bridge_outbound_prepared'],
            ['dispatching', 'bridge_outbound_dispatching'],
            ['awaitingEcho', 'bridge_outbound_awaiting_echo'],
            ['uncertain', 'bridge_outbound_uncertain'],
        ] as const) {
            const count = snapshot.queues[key];
            if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid queue metric');
            values.push([name, 'Current durable records in this processing stage.', count]);
        }
    }
    if (snapshot.reactionQueues) {
        for (const [key, name] of [
            ['prepared', 'bridge_reaction_parts_prepared'],
            ['dispatching', 'bridge_reaction_parts_dispatching'],
            ['uncertain', 'bridge_reaction_parts_uncertain'],
            ['failureNotices', 'bridge_reaction_failure_notices_pending'],
            ['retirements', 'bridge_reaction_redactions_pending'],
        ] as const) {
            const count = snapshot.reactionQueues[key];
            if (!Number.isSafeInteger(count) || count < 0)
                throw new Error('Invalid reaction queue metric');
            values.push([name, 'Current durable reaction work awaiting completion.', count]);
        }
    }
    if (snapshot.mediaQueues) {
        for (const [key, name] of [
            ['prepared', 'bridge_media_prepared'],
            ['dispatching', 'bridge_media_dispatching'],
            ['awaitingEcho', 'bridge_media_awaiting_echo'],
            ['uncertain', 'bridge_media_uncertain'],
        ] as const) {
            const count = snapshot.mediaQueues[key];
            if (!Number.isSafeInteger(count) || count < 0)
                throw new Error('Invalid media queue metric');
            values.push([name, 'Current durable media requests in this processing stage.', count]);
        }
    }
    return values
        .map(
            ([name, help, value]) =>
                `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`,
        )
        .join('');
}
