import type {InboxEvent} from '../matrix/transaction-inbox.ts';
import {parseManagementCommand, managementHelp, type ManagementCommand} from './commands.ts';

type Action = Exclude<ManagementCommand, {kind: 'invalid' | 'local-only'}>;

/** Authorization boundary for a dedicated encrypted management room. No secret-bearing commands. */
export class ManagementCommandHandler {
    private readonly options: {
        owner: string;
        room: string;
        authorize: () => Promise<void>;
        execute: (command: Action, eventId: string) => Promise<Record<string, unknown>>;
        reply: (eventId: string, content: Record<string, unknown>) => Promise<void>;
    };
    constructor(options: ManagementCommandHandler['options']) {
        if (!/^@[^\s]+:[^\s]+$/.test(options.owner) || !/^![^\s]+:[^\s]+$/.test(options.room))
            throw new Error('Invalid management room configuration');
        this.options = options;
    }
    async handle(event: InboxEvent): Promise<boolean> {
        if (
            event.room_id !== this.options.room ||
            event.sender !== this.options.owner ||
            event.encrypted !== true ||
            event.state_key !== undefined
        )
            return false;
        if (event.type !== 'm.room.message' || event.content.msgtype !== 'm.text') return false;
        // Edits, replies and threads must not unexpectedly re-run an administrative action.
        if (event.content['m.relates_to'] !== undefined) return false;
        await this.options.authorize();
        const command = parseManagementCommand(event.content.body);
        let content: Record<string, unknown>;
        if (command.kind === 'invalid' || command.kind === 'help')
            content = {msgtype: 'm.notice', body: managementHelp};
        else if (command.kind === 'local-only')
            content = {
                msgtype: 'm.notice',
                body: 'Use local administration for linking, unlocking, recovery, revocation or deletion. Never send recovery secrets to Matrix.',
            };
        else content = await this.options.execute(command as Action, event.event_id);
        await this.options.reply(event.event_id, content);
        return true;
    }
}
