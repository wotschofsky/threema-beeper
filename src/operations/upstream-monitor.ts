import {createHash} from 'node:crypto';

export const upstreamSources = {
    tags: 'https://api.github.com/repos/threema-ch/threema-desktop/tags?per_page=100',
    changelog: 'https://threema.com/en/changelog/desktop-md',
    terms: 'https://threema.com/en/tos',
} as const;
type Source = keyof typeof upstreamSources;
export interface UpstreamState {
    schemaVersion: 1;
    snapshots: Partial<Record<Source, string>>;
    pending: Partial<Record<Source, 'changed' | 'unavailable'>>;
    revisions?: Partial<Record<Source, number>>;
}
const sources = Object.keys(upstreamSources) as Source[];
const maximumBytes = 2 * 1024 * 1024;

/** A review applies only to the exact observed revision, never to a later change. */
export function reviewUpstream(previous: UpstreamState, source: string, revision: number): UpstreamState {
    const state = parseUpstreamState(previous);
    if (!sources.includes(source as Source) || !Number.isSafeInteger(revision) || revision < 0)
        throw new Error('Invalid upstream review');
    const key = source as Source;
    if (!state.snapshots[key] || (state.revisions![key] ?? 0) !== revision)
        throw new Error('Upstream review is stale');
    if (state.pending[key] === 'unavailable') throw new Error('An unavailable check cannot be reviewed');
    delete state.pending[key];
    return state;
}

export function parseUpstreamState(value: unknown): UpstreamState {
    if (!value || typeof value !== 'object') throw new Error('Invalid upstream monitor state');
    const state = value as UpstreamState;
    if (state.schemaVersion !== 1) throw new Error('Invalid upstream monitor state');
    for (const field of ['snapshots', 'pending'] as const) {
        const entries = state[field];
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid upstream monitor state');
        for (const [key, entry] of Object.entries(entries)) {
            if (!sources.includes(key as Source) || typeof entry !== 'string' ||
                (field === 'snapshots' ? !/^[a-f0-9]{64}$/u.test(entry) : !['changed', 'unavailable'].includes(entry)))
                throw new Error('Invalid upstream monitor state');
        }
    }
    const revisions = state.revisions ?? {};
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions) ||
        Object.entries(revisions).some(([key, revision]) => !sources.includes(key as Source) ||
            !Number.isSafeInteger(revision) || revision < 0)) throw new Error('Invalid upstream revisions');
    return {schemaVersion: 1, snapshots: {...state.snapshots}, pending: {...state.pending}, revisions: {...revisions}};
}

function digest(source: Source, text: string): string {
    if (source === 'tags') {
        const data: unknown = JSON.parse(text);
        if (!Array.isArray(data) || !data.length || data.length > 100) throw new Error('Invalid tags');
        text = JSON.stringify(data.map((tag: unknown) => {
            if (!tag || typeof tag !== 'object') throw new Error('Invalid tag');
            const item = tag as {name?: unknown; commit?: {sha?: unknown}};
            if (typeof item.name !== 'string' || item.name.length > 128 ||
                typeof item.commit?.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(item.commit.sha)) throw new Error('Invalid tag');
            return [item.name, item.commit.sha];
        }).sort((a, b) => a[0]!.localeCompare(b[0]!)));
    } else {
        // Ignore script/style churn; any remaining page change asks for human review.
        text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '')
            .replace(/<!--[^]*?-->/gu, '').replace(/\s+/gu, ' ').trim();
        if (text.length < 100 || !/<html\b/iu.test(text)) throw new Error('Invalid page');
    }
    return createHash('sha256').update(text).digest('hex');
}

async function readSource(source: Source, request: typeof fetch): Promise<string> {
    const response = await request(upstreamSources[source], {
        redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: {'User-Agent': 'threema-beeper-upstream-monitor', Accept: source === 'tags' ? 'application/vnd.github+json' : 'text/html'},
    });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Upstream unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maximumBytes) throw new Error('Upstream response too large');
            chunks.push(chunk.value);
        }
        return digest(source, Buffer.concat(chunks).toString('utf8'));
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

export async function checkUpstream(previous: UpstreamState, request: typeof fetch = fetch): Promise<{
    state: UpstreamState; changed: Source[]; unavailable: Source[];
}> {
    const state = parseUpstreamState(previous);
    const results = await Promise.allSettled(sources.map(source => readSource(source, request)));
    const changed: Source[] = [];
    const unavailable: Source[] = [];
    const advance = (source: Source) => {
        const revision = (state.revisions![source] ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('Upstream revision exhausted');
        state.revisions![source] = revision;
    };
    for (const [index, source] of sources.entries()) {
        const result = results[index]!;
        if (result.status === 'rejected') {
            unavailable.push(source);
            // Preserve an unacknowledged change across a later network failure.
            if (!state.pending[source]) advance(source);
            state.pending[source] ??= 'unavailable';
            continue;
        }
        if (state.snapshots[source] && state.snapshots[source] !== result.value) {
            advance(source);
            changed.push(source);
            state.pending[source] = 'changed';
        }
        if (state.pending[source] === 'unavailable') delete state.pending[source];
        state.snapshots[source] = result.value;
    }
    return {state, changed, unavailable};
}
