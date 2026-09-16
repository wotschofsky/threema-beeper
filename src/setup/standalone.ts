import {setTimeout as delay} from 'node:timers/promises';
import type {LinkSession} from './link-session.ts';
import {startSetupServer} from './setup-server.ts';

type Session = Pick<
    LinkSession,
    'state' | 'begin' | 'cancel' | 'stop' | 'finish' | 'recoverySecret'
>;
export type SetupOutcome = 'finished' | 'cancelled' | 'interrupted' | 'error';

/** Standalone setup owns the backend lifetime. The service will use startSetupServer directly. */
export async function runStandaloneSetup(
    session: Session,
    options: {port?: number; signal: AbortSignal; onUrl: (url: string) => void},
): Promise<SetupOutcome> {
    if (options.signal.aborted) return 'interrupted';
    const server = await startSetupServer(session, {port: options.port});
    try {
        if (!options.signal.aborted) options.onUrl(server.url);
        while (!options.signal.aborted) {
            const state = session.state.state;
            if (
                state === 'finished' ||
                state === 'cancelled' ||
                state === 'interrupted' ||
                state === 'error'
            ) {
                if (state === 'error' || state === 'interrupted') {
                    const wait = new AbortController();
                    try {
                        await Promise.race([
                            server.terminalStateDelivered,
                            delay(5000, undefined, {
                                signal: AbortSignal.any([options.signal, wait.signal]),
                            }),
                        ]);
                    } catch (error) {
                        if (!options.signal.aborted) throw error;
                    } finally {
                        wait.abort();
                    }
                }
                return options.signal.aborted ? 'interrupted' : state;
            }
            try {
                await delay(100, undefined, {signal: options.signal});
            } catch (error) {
                if (!options.signal.aborted) throw error;
            }
        }
        return 'interrupted';
    } finally {
        try {
            await server.close();
        } finally {
            await session.stop();
        }
    }
}
