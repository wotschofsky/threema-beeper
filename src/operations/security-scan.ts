import {createHash} from 'node:crypto';

const severities = ['Unknown', 'Negligible', 'Low', 'Medium', 'High', 'Critical'] as const;
type Severity = typeof severities[number];
export interface SecurityFinding {key: string; severity: Severity}
export interface SecurityScan {
    imageId: string;
    findings: SecurityFinding[];
}
const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scan object');
    return value as Record<string, unknown>;
};
const field = (value: unknown): string => {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096)
        throw new Error('Invalid scan field');
    return value;
};

/** Accept only an inventory scan of the exact installed image. Never include report text in notices. */
export function parseSecurityScan(value: unknown, expectedImageId: string): SecurityScan {
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedImageId)) throw new Error('Invalid expected image');
    const report = object(value);
    const source = object(report.source);
    if (source.type !== 'image' || object(source.target).imageID !== expectedImageId)
        throw new Error('Scan does not describe the installed image');
    if (!Array.isArray(report.matches) || report.matches.length > 100_000)
        throw new Error('Invalid scan matches');
    // An accidentally configured ignore rule must not silently make weekly results look clean.
    if (report.ignoredMatches !== undefined &&
        (!Array.isArray(report.ignoredMatches) || report.ignoredMatches.length !== 0))
        throw new Error('Suppressed findings are not accepted');
    const findings = new Map<string, Severity>();
    for (const raw of report.matches) {
        const match = object(raw), vulnerability = object(match.vulnerability), artifact = object(match.artifact);
        const severity = field(vulnerability.severity) as Severity;
        if (!severities.includes(severity)) throw new Error('Invalid finding severity');
        const key = createHash('sha256').update(JSON.stringify([
            field(vulnerability.namespace), field(vulnerability.id),
            field(artifact.type), field(artifact.name), field(artifact.version),
        ])).digest('hex');
        const previous = findings.get(key);
        if (!previous || severities.indexOf(severity) > severities.indexOf(previous)) findings.set(key, severity);
    }
    return {imageId: expectedImageId,
        findings: [...findings].sort(([a], [b]) => a.localeCompare(b)).map(([key, severity]) => ({key, severity}))};
}

export interface SecurityScanState {
    schemaVersion: 1;
    scan?: SecurityScan;
    revision: number;
    lastResult: 'success' | 'failed';
    pending?: {revision: number; kind: 'findings' | 'failed'; count: number};
}
export function parseSecurityScanState(value: unknown): SecurityScanState {
    const state = object(value);
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 ||
        !['success', 'failed'].includes(state.lastResult as string)) throw new Error('Invalid scan state');
    let scan: SecurityScan | undefined;
    if (state.scan !== undefined) {
        const item = object(state.scan);
        if (typeof item.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.imageId) ||
            !Array.isArray(item.findings) || item.findings.length > 100_000) throw new Error('Invalid saved scan');
        const keys = new Set<string>();
        const findings = item.findings.map(raw => {
            const finding = object(raw);
            if (typeof finding.key !== 'string' || !/^[a-f0-9]{64}$/.test(finding.key) ||
                keys.has(finding.key) || !severities.includes(finding.severity as Severity)) throw new Error('Invalid saved finding');
            keys.add(finding.key);
            return {key: finding.key, severity: finding.severity as Severity};
        });
        scan = {imageId: item.imageId, findings};
    }
    let pending: SecurityScanState['pending'];
    if (state.pending !== undefined) {
        const p = object(state.pending);
        if (!Number.isSafeInteger(p.revision) || (p.revision as number) < 1 || p.revision !== state.revision ||
            !['findings', 'failed'].includes(p.kind as string) || !Number.isSafeInteger(p.count) ||
            (p.count as number) < 0 || (p.count as number) > 100_000 ||
            (p.kind === 'failed' ? p.count !== 0 : p.count === 0)) throw new Error('Invalid pending scan notice');
        pending = {revision: p.revision as number, kind: p.kind as 'findings' | 'failed', count: p.count as number};
    }
    return {schemaVersion: 1, revision: state.revision as number,
        lastResult: state.lastResult as 'success' | 'failed', ...(scan ? {scan} : {}), ...(pending ? {pending} : {})};
}

/** Quiet for reordered/unchanged/resolved matches; alert for new matches or increased severity. */
export function advanceSecurityScan(previous: SecurityScanState | undefined, scan?: SecurityScan): SecurityScanState {
    const state = previous ? parseSecurityScanState(previous)
        : {schemaVersion: 1 as const, revision: 0, lastResult: 'success' as const};
    let count = 0;
    if (scan) {
        scan = parseSecurityScanState({schemaVersion: 1, revision: 0, lastResult: 'success', scan}).scan!;
        const known = new Map(state.scan?.findings.map(f => [f.key, f.severity]));
        count = scan.findings.filter(f => !known.has(f.key) ||
            severities.indexOf(f.severity) > severities.indexOf(known.get(f.key)!)).length;
    }
    const alert = scan ? count > 0 : state.lastResult !== 'failed';
    const revision = state.revision + (alert ? 1 : 0);
    if (!Number.isSafeInteger(revision)) throw new Error('Scan revision exhausted');
    return parseSecurityScanState({...state, ...(scan ? {scan} : {}), revision,
        lastResult: scan ? 'success' : 'failed',
        // Preserve an undelivered notice across recovery; its content remains stable.
        ...(alert ? {pending: {revision, kind: scan ? 'findings' : 'failed', count}} : {})});
}
