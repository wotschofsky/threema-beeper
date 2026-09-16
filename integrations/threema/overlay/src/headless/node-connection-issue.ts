export const connectionIssues = [
    'client-update-required', 'mediator-update-required', 'client-was-dropped',
    'device-slot-state-mismatch', 'device-protocols-incompatible',
] as const;
export type ConnectionIssue = typeof connectionIssues[number];
export function parseConnectionIssue(value: unknown): ConnectionIssue | undefined {
    return typeof value === 'string' && connectionIssues.includes(value as ConnectionIssue)
        ? value as ConnectionIssue : undefined;
}

/** Only typed upstream categories cross this boundary; arbitrary dialog context never does. */
export function connectionDialogIssue(dialog: unknown): ConnectionIssue | undefined {
    if (!dialog || typeof dialog !== 'object') return undefined;
    const value = dialog as {type?: unknown; context?: {error?: unknown}};
    if (value.type === 'device-protocols-incompatible') return 'device-protocols-incompatible';
    if (value.type !== 'connection-error') return undefined;
    const issue = parseConnectionIssue(value.context?.error);
    return issue === 'device-protocols-incompatible' ? undefined : issue;
}

export function dismissConnectionDialog(dialog: unknown, report: (issue: ConnectionIssue) => void):
    {closed: Promise<{type: 'dismissed'}>; setProgress: (progress: number) => void} | undefined {
    const issue = connectionDialogIssue(dialog);
    if (!issue) return undefined;
    try { report(issue); } catch { /* Reporting cannot turn dismissal into confirmation. */ }
    return {closed: Promise.resolve({type: 'dismissed'}), setProgress: () => undefined};
}
