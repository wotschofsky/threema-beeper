import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {test} from 'node:test';
import {receiveMessages, serveMessages} from '../src/threema/message-subscription.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

const message: NormalizedNodeMessage = {
    chatId: 'c:TEST1234',
    messageId: 'm:0100000000000000',
    direction: 'outbound',
    senderIdentity: 'SELF1234',
    createdAt: new Date(0),
    ordinal: 1n,
    reactions: [],
    content: {type: 'text', text: 'synthetic'},
};
await test('malformed and wrong-chat packets reset before reaching the consumer', {timeout: 5000}, async () => {
    for (const value of [{...message, chatId: 'c:OTHER123'}, {...message, encryptionKey: 'secret'}]) {
        const channel = new MessageChannel();
        let signal!: () => void;
        const reset = new Promise<void>(resolve => {signal = resolve;});
        let consumed = false;
        const client = receiveMessages(channel.port1, message.chatId, async () => {consumed = true;}, signal);
        try {
            channel.port2.postMessage({type: 'message', id: 1, value});
            await reset;
            assert.equal(consumed, false);
        } finally {client.dispose(); channel.port2.close();}
    }
});
await test(
    'message port waits for consumer commit before acknowledging and closes its source',
    {timeout: 5000},
    async () => {
        const channel = new MessageChannel();
        let emit!: (value: NormalizedNodeMessage) => Promise<void>;
        let stopped = 0;
        await serveMessages(channel.port2, message.chatId, async (consume) => {
            emit = consume;
            return async () => {
                stopped++;
            };
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let commit!: () => void;
        const committing = new Promise<void>((resolve) => {
            commit = resolve;
        });
        let reset = false;
        const client = receiveMessages(
            channel.port1,
            message.chatId,
            async (value) => {
                assert.deepEqual(value, message);
                entered();
                await committing;
            },
            () => {
                reset = true;
            },
        );
        try {
            let acknowledged = false;
            const sending = emit(message).then(() => {
                acknowledged = true;
            });
            await started;
            assert.equal(acknowledged, false);
            commit();
            await sending;
            await client.stop();
            assert.equal(stopped, 1);
            assert.equal(reset, false);
        } finally {
            commit();
            client.dispose();
            channel.port2.close();
        }
    },
);
await test(
    'consumer failure invalidates a subscription',
    {timeout: 5000},
    async () => {
        const channel = new MessageChannel();
        let emit!: (value: NormalizedNodeMessage) => Promise<void>;
        await serveMessages(channel.port2, message.chatId, async (consume) => {
            emit = consume;
            return async () => undefined;
        });
        let signal!: () => void;
        const reset = new Promise<void>((resolve) => {
            signal = resolve;
        });
        const client = receiveMessages(
            channel.port1,
            message.chatId,
            async () => {
                throw new Error('synthetic commit failure');
            },
            signal,
        );
        try {
            const rejected = assert.rejects(emit(message));
            await reset;
            await rejected;
            await client.stop();
        } finally {
            client.dispose();
            channel.port2.close();
        }
    },
);
await test(
    'missing acknowledgement expires the stream and detaches its source',
    {timeout: 5000},
    async () => {
        const channel = new MessageChannel();
        let emit!: (value: NormalizedNodeMessage) => Promise<void>;
        let stopped = 0;
        channel.port1.on('message', () => undefined);
        await serveMessages(
            channel.port2,
            message.chatId,
            async (consume) => {
                emit = consume;
                return async () => {
                    stopped++;
                };
            },
            20,
        );
        try {
            await assert.rejects(emit(message));
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(stopped, 1);
        } finally {
            channel.port1.close();
            channel.port2.close();
        }
    },
);
