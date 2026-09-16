import type {SetupState} from '../link-session.ts';

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error('Setup page is incomplete');
    return value as T;
}
const title = element('title');
const description = element('description');
const error = element('error');
let stopped = false;
let lastState = '';
let recoveryLoaded = false;

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? {} : {'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        if (response.status === 401 || response.status === 410)
            throw new Error(
                'This setup session has expired or is already in use. Open a fresh local setup link.',
            );
        throw new Error(
            'That action could not be completed. Your existing profile has been preserved.',
        );
    }
    return await response.json();
}
function showError(reason: unknown): void {
    error.textContent =
        reason instanceof Error ? reason.message : 'The local setup connection was interrupted.';
    error.hidden = false;
}
function render(state: SetupState): void {
    const key = JSON.stringify(state);
    if (key === lastState) return;
    lastState = key;
    // An earlier action error is obsolete once the backend advances to a new state.
    error.hidden = true;
    for (const id of [
        'idle',
        'qr-panel',
        'confirm-panel',
        'sync-panel',
        'recovery-panel',
        'done-panel',
    ])
        element(id).hidden = true;
    for (const id of ['step-link', 'step-confirm', 'step-save'])
        element(id).removeAttribute('aria-current');
    element('cancel').hidden = !['preparing', 'qr', 'confirm'].includes(state.state);
    let step = 'step-link';
    switch (state.state) {
        case 'idle':
            title.textContent = 'Link your Threema phone';
            description.textContent =
                'Add this bridge as a linked device to bring your conversations into Beeper.';
            element('idle').hidden = false;
            break;
        case 'preparing':
            title.textContent = 'Preparing your secure link';
            description.textContent = 'The bridge is starting a private pairing session.';
            break;
        case 'qr':
            title.textContent = 'Scan with Threema';
            description.textContent = 'Use the linked-device scanner inside the Threema app.';
            element<HTMLImageElement>('qr').src = '/qr?revision=' + Date.now();
            element('qr-panel').hidden = false;
            break;
        case 'confirm':
            step = 'step-confirm';
            title.textContent = 'Compare these three emojis';
            description.textContent = 'Look for the same emojis on your phone.';
            element('emojis').replaceChildren(
                ...state.emojis.map((emoji) => {
                    const span = document.createElement('span');
                    span.textContent = emoji;
                    return span;
                }),
            );
            element('confirm-panel').hidden = false;
            break;
        case 'syncing':
            step = 'step-confirm';
            title.textContent = 'Linking your profile';
            description.textContent =
                'Your recovery secret is saved locally. Wait for the transfer to finish.';
            element('sync-panel').hidden = false;
            break;
        case 'ready':
            element('identity').textContent = state.identity;
            step = 'step-save';
            title.textContent = 'Save your recovery secret';
            description.textContent =
                'The profile is linked. Save one final thing before closing setup.';
            element('recovery-panel').hidden = false;
            break;
        case 'finished':
            step = 'step-save';
            title.textContent = 'Profile setup complete';
            description.textContent = 'Your recovery secret is saved and acknowledged.';
            element<HTMLTextAreaElement>('secret').value = '';
            element('done-panel').hidden = false;
            stopped = true;
            break;
        case 'cancelled':
            title.textContent = 'Linking cancelled';
            description.textContent =
                'The incomplete profile from this attempt was removed. Open a new local setup link to try again.';
            stopped = true;
            break;
        case 'interrupted':
        case 'error':
            title.textContent = 'Setup needs attention';
            description.textContent =
                'The link could not finish. Any profile that may have registered was preserved for local recovery.';
            stopped = true;
            break;
    }
    element(step).setAttribute('aria-current', 'step');
}
async function poll(): Promise<void> {
    if (stopped) return;
    try {
        const state = await api<SetupState>('/state');
        if (!stopped) render(state);
    } catch (reason) {
        if (!stopped) showError(reason);
        stopped = true;
    }
    if (!stopped)
        setTimeout(() => {
            void poll();
        }, 1000);
}
function action(id: string, run: () => Promise<void>): void {
    const button = element<HTMLButtonElement>(id);
    button.addEventListener('click', () => {
        button.disabled = true;
        error.hidden = true;
        void run()
            .catch(showError)
            .finally(() => {
                button.disabled = false;
            });
    });
}
action('begin', async () => {
    await api('/begin', {});
    render(await api<SetupState>('/state'));
});
action('cancel', async () => {
    await api('/cancel', {});
    render(await api<SetupState>('/state'));
});
action('reveal', async () => {
    const {secret} = (await api('/recovery')) as {secret: string};
    element<HTMLTextAreaElement>('secret').value = secret;
    element('secret-panel').hidden = false;
    element('reveal').hidden = true;
    recoveryLoaded = true;
    element<HTMLInputElement>('saved').disabled = false;
});
action('copy', async () => {
    await navigator.clipboard.writeText(element<HTMLTextAreaElement>('secret').value);
    element('copy-status').textContent = 'Copied';
});
element<HTMLInputElement>('saved').disabled = true;
element('saved').addEventListener('change', () => {
    element<HTMLButtonElement>('finish').disabled =
        !recoveryLoaded || !element<HTMLInputElement>('saved').checked;
});
action('finish', async () => {
    if (!recoveryLoaded || !element<HTMLInputElement>('saved').checked) return;
    await api('/finish', {recoverySaved: true});
    render({state: 'finished'});
});
void (async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get('setup');
    history.replaceState(undefined, '', location.pathname);
    if (token) await api('/session', {token});
    await poll();
})().catch(showError);
