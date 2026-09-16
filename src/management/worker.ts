import {createHash} from 'node:crypto';
import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import {ManagementCommandHandler} from './command-handler.ts';

type HandlerOptions = ConstructorParameters<typeof ManagementCommandHandler>[0];

/** Persist results before replying; adapters must recover effects by source event ID. */
export class ManagementWorker {
    private readonly options: {
        inbox: TransactionInbox;
        room: string;
        owner: string;
        ready: () => boolean;
        authorize: HandlerOptions['authorize'];
        execute: HandlerOptions['execute'];
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    private readonly handler: ManagementCommandHandler;
    private cursor = 0;
    private running?: Promise<number>;

    constructor(options: ManagementWorker['options']) {
        this.options = options;
        this.handler = new ManagementCommandHandler({
            owner: options.owner,
            room: options.room,
            authorize: async () => {
                await options.authorize();
                if (!options.ready()) throw new Error('Management service unavailable');
            },
            execute: async (command, id) => {
                const saved = options.inbox.managementResult(id);
                if (saved) return saved;
                const result = await options.execute(command, id);
                options.inbox.saveManagementResult(id, result);
                return result;
            },
            reply: async (id, content) => {
                // Help and local-only commands also need immutable output across upgrades/retries.
                const saved = options.inbox.managementResult(id);
                if (!saved) options.inbox.saveManagementResult(id, content);
                await options.authorize();
                if (!options.ready()) throw new Error('Management service unavailable');
                const transaction =
                    'management_' +
                    createHash('sha256')
                        .update(JSON.stringify([options.room, options.owner, id]))
                        .digest('hex');
                await options.send(transaction, options.room, {
                    ...(saved ?? content),
                    'm.relates_to': {'m.in_reply_to': {event_id: id}},
                });
            },
        });
    }

    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid management batch size'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }

    private async process(limit: number): Promise<number> {
        const {inbox} = this.options;
        if (!this.options.ready()) return 0;
        let page = inbox.pendingDeliveryPage(limit, this.cursor);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = inbox.pendingDeliveryPage(limit);
        }
        let completed = 0;
        for (const {sequence, event, transactionId} of page) {
            if (!this.options.ready()) break;
            if (transactionId && (await this.handler.handle(event))) {
                inbox.acknowledgeEvent(event.event_id);
                completed++;
            }
            // A failing command stays first on the next retry, preserving command order.
            this.cursor = sequence;
        }
        return completed;
    }
}
