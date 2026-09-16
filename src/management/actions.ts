import type {ManagementCommand} from './commands.ts';
import {managementHelp} from './commands.ts';
import type {DirectorySnapshot} from '../threema/directory.ts';
import {BackendWorkerError} from '../threema/backend-controller.ts';
import type {MediaJournal} from '../outbox/media-journal.ts';

type Action = Exclude<ManagementCommand, {kind: 'invalid' | 'local-only'}>;

/** Render only explicit non-secret fields; never serialize backend/diagnostic objects to Matrix. */
export class ManagementActions {
    private readonly options: {
        status: () => {ready: boolean; mediaQueues?: ReturnType<MediaJournal['pendingCounts']>};
        directory: () => Promise<DirectorySnapshot>;
        resync: () => boolean;
        doctor: () => Promise<{checks: {status: 'pass' | 'fail' | 'unknown'}[]}>;
        version: () => Promise<{source: {sha256: string}}>;
        /** Must resolve through upstream services and recover creation by stable identity. */
        pm: (identity: string, eventId: string) => Promise<string>;
    };
    constructor(options: ManagementActions['options']) {
        this.options = options;
    }

    async execute(command: Action, eventId: string): Promise<Record<string, unknown>> {
        let body: string;
        switch (command.kind) {
            case 'help':
                body = managementHelp;
                break;
            case 'status': {
                const status = this.options.status();
                body =
                    status.ready === true
                        ? 'Bridge ready for messages.'
                        : 'Bridge is not ready for messages.';
                if (status.mediaQueues) {
                    const {prepared, dispatching, awaitingEcho, uncertain} = status.mediaQueues;
                    if (
                        ![prepared, dispatching, awaitingEcho, uncertain].every(
                            (value) => Number.isSafeInteger(value) && value >= 0,
                        )
                    )
                        throw new Error('Invalid media queue status');
                    body += ` Files: ${prepared} queued, ${dispatching} sending, ${awaitingEcho} awaiting confirmation, ${uncertain} uncertain.`;
                    if (uncertain) body += ' Uncertain sends are not retried automatically.';
                }
                break;
            }
            case 'resync':
                body = this.options.resync()
                    ? 'Reconciliation requested. Existing credentials and queued messages are preserved.'
                    : 'Reconciliation is unavailable while the service is stopped.';
                break;
            case 'contacts': {
                if (command.after !== undefined && !/^[A-Z0-9*][A-Z0-9]{7}$/.test(command.after))
                    throw new Error('Invalid contact cursor');
                const {contacts} = await this.options.directory();
                const rows = contacts
                    .slice()
                    .sort((a, b) =>
                        a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
                    );
                const remaining =
                    command.after === undefined
                        ? rows
                        : rows.filter((row) => row.identity > command.after!);
                const selected = remaining.slice(0, 100);
                const lines = selected.map((contact) => {
                    if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(contact.identity))
                        throw new Error('Invalid management contact');
                    // Keep untrusted names on one line and remove bidi formatting controls.
                    const name = Array.from(
                        contact.displayName.replace(
                            /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
                            ' ',
                        ),
                    )
                        .slice(0, 100)
                        .join('');
                    return `${contact.identity} — ${name}${contact.blocked ? ' (blocked)' : ''}`;
                });
                body = selected.length
                    ? lines.join('\n')
                    : command.after === undefined
                      ? 'No contacts are available.'
                      : 'No more contacts after this ID.';
                if (selected.length) {
                    body += `\nShowing ${selected.length} of ${rows.length} contacts.`;
                    if (remaining.length > selected.length)
                        body += ` Next: contacts after ${selected.at(-1)!.identity}`;
                }
                break;
            }
            case 'doctor': {
                const {checks} = await this.options.doctor();
                const counts = {pass: 0, fail: 0, unknown: 0};
                for (const check of checks) {
                    if (!Object.hasOwn(counts, check.status))
                        throw new Error('Invalid diagnostic result');
                    counts[check.status]++;
                }
                body = `Local checks: ${counts.pass} passed, ${counts.fail} failed, ${counts.unknown} unverified. Use the local doctor command for details. Live end-to-end delivery is not verified by these checks.`;
                break;
            }
            case 'version': {
                const result = await this.options.version();
                if (!/^[a-f0-9]{64}$/.test(result.source.sha256))
                    throw new Error('Invalid source version');
                body = `Threema bridge development build. Source SHA-256: ${result.source.sha256}. Installed native artifacts are not verified by this source digest.`;
                break;
            }
            case 'pm': {
                if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(command.identity))
                    throw new Error('Invalid contact identity');
                let room: string;
                try {
                    room = await this.options.pm(command.identity, eventId);
                } catch (error) {
                    if (
                        error instanceof BackendWorkerError &&
                        error.code === 'contact-unavailable'
                    ) {
                        body = 'This Threema ID is unavailable. No chat was created.';
                        break;
                    }
                    if (error instanceof BackendWorkerError && error.code === 'contact-is-self') {
                        body =
                            'This is your own Threema ID. A direct contact chat with yourself cannot be created.';
                        break;
                    }
                    throw error;
                }
                if (!/^![^\s]+:[^\s]+$/.test(room) || room.length > 1024)
                    throw new Error('Invalid contact portal');
                body = `Chat ready: https://matrix.to/#/${encodeURIComponent(room)}`;
                break;
            }
        }
        if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Management output exceeds limit');
        return {msgtype: 'm.notice', body};
    }
}
