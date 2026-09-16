/** Synthetic browser fixture. Never creates a backend or accesses accounts. */
import {createInterface} from 'node:readline';
import {startSetupServer} from '../src/setup/setup-server.ts';
import type {SetupState} from '../src/setup/link-session.ts';

let state: SetupState = {state: 'idle'};
const server = await startSetupServer({
    get state() {
        return state;
    },
    begin: async () => {
        state = {state: 'qr', uri: 'threema://synthetic-browser-test'};
    },
    cancel: async () => {
        state = {state: 'cancelled'};
    },
    stop: async () => {
        state = {state: 'interrupted'};
    },
    recoverySecret: () => {
        if (state.state !== 'ready') throw new Error('Not ready');
        return 'SYNTHETIC-ONLY-THIS-IS-NOT-A-REAL-PROFILE-KEY';
    },
    finish: (accepted) => {
        if (!accepted || state.state !== 'ready') throw new Error('Not ready');
        state = {state: 'finished'};
    },
});
console.log(server.url);
const input = createInterface({input: process.stdin});
input.on('line', (line) => {
    if (line === 'confirm') state = {state: 'confirm', emojis: ['🍏', '🐈', '🚲']};
    if (line === 'ready') state = {state: 'ready', identity: 'TEST1234'};
    if (line === 'stop') void server.close().then(() => input.close());
});
