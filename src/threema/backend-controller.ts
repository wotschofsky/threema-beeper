import {parseReadCommand, type ReadCommand} from './read-command.ts';
import {parseProfilePicture, pictureIdentity} from './profile-picture.ts';
import {receiveConnection} from './connection-subscription.ts';
import {parseConnectionIssue, type ConnectionIssue} from '../../integrations/threema/overlay/src/headless/node-connection-issue.ts';
import {parseTypingCommand, type NodeTypingRequest} from './typing-command.ts';
import {parseMutationCommand, type NodeMutationRequest} from './mutation-command.ts';
import {parsePreparedVideoSend, type PreparedVideoSend} from './prepared-video-send.ts';
import {parsePreparedImageSend, type PreparedImageSend} from './prepared-image-send.ts';
import {parseDiscardPreparedFile, type DiscardPreparedFile} from './prepare-file-command.ts';
import {parsePreparedFileSend, type PreparedFileSend} from './prepared-file-send.ts';
import {acceptSendAllocation, parseTextSend, type TextSendRequest} from './send-allocation.ts';
import {parseReactionCommand, type NodeReactionRequest} from './reaction-command.ts';
import type {Readable} from 'node:stream';
import {
    parseMediaRequest,
    parseMediaInfo,
    type MediaRequest,
    type MediaInfo,
} from './media-commands.ts';
import {
    parsePrepareFile,
    parsePreparedToken,
    type PrepareFileRequest,
} from './prepare-file-command.ts';
import {serveByteStream, receiveByteStream} from './byte-stream.ts';
import {Worker, MessageChannel, type Transferable} from 'node:worker_threads';
import {receiveMessages} from './message-subscription.ts';
import {receiveTopology} from './topology-subscription.ts';
import {parseDirectory, type DirectorySnapshot} from './directory.ts';
import {parseConversations, type ConversationSummary} from './conversations.ts';
import {
    parseHistoryRequest,
    parseHistoryPage,
    type HistoryCursor,
    type HistoryPage,
    type NormalizedNodeMessage,
} from './history.ts';

export class BackendWorkerError extends Error {
    readonly code: string;
    constructor(code: string, options?: ErrorOptions) {
        super(code, options);
        this.code = code;
    }
}

/** One dedicated worker per profile. Worker termination owns connection/task cancellation. */
export class BackendController {
    private readonly worker: Worker;
    private readonly pending = new Map<
        number,
        {resolve: (value: unknown) => void; reject: (error: Error) => void}
    >();
    private nextId = 1;
    private stopped = false;
    private stopping?: Promise<void>;
    private gracefulStop?: Promise<void>;
    private draining = false;
    private readonly preparationStreams = new Set<Readable>();
    private readyResolve!: () => void;
    private readyReject!: (error: Error) => void;
    readonly ready: Promise<void>;

    constructor(
        options: {
            profileDirectory: string;
            wasmFile: string;
            onState?: (type: 'link-state' | 'load-state', state: unknown) => void;
            onConnectionIssue?: (issue: ConnectionIssue) => void;
        },
        createWorker: (
            entry: URL,
            options: import('node:worker_threads').WorkerOptions,
        ) => Worker = (entry, options) => new Worker(entry, options),
    ) {
        this.ready = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        // A caller may cancel immediately, before it awaits ready.
        void this.ready.catch(() => undefined);
        this.worker = createWorker(new URL('./entry.backend-worker.ts', import.meta.url), {
            workerData: {profileDirectory: options.profileDirectory, wasmFile: options.wasmFile},
            stdout: true,
            stderr: true,
        });
        this.worker.on(
            'message',
            (message: {
                type: string;
                id?: number;
                code?: string;
                state?: unknown;
                value?: unknown;
            }) => {
                if (this.stopped) return;
                if (message.type === 'connection-issue') {
                    const issue = parseConnectionIssue(message.code);
                    if (issue) {
                        try { options.onConnectionIssue?.(issue); }
                        catch { /* A notice callback must not strand backend requests. */ }
                    }
                    return;
                }
                if (message.type === 'initialized') {
                    this.readyResolve();
                    return;
                }
                if (message.type === 'fatal') {
                    void this.stopWithError(
                        new BackendWorkerError(
                            message.code === 'profile-in-use'
                                ? 'profile-in-use'
                                : 'backend-initialization-failed',
                        ),
                    );
                    return;
                }
                if (message.type === 'link-state' || message.type === 'load-state') {
                    try {
                        options.onState?.(message.type, message.state);
                    } catch {
                        /* A UI callback must not strand backend requests. */
                    }
                    return;
                }
                const pending = this.pending.get(message.id ?? -1);
                if (!pending) return;
                this.pending.delete(message.id!);
                if (message.type === 'result') pending.resolve(message.value);
                else
                    pending.reject(
                        new BackendWorkerError(message.code ?? 'backend-operation-failed'),
                    );
            },
        );
        this.worker.on('error', (error) => {
            void this.stopWithError(
                new BackendWorkerError('backend-worker-failed', {cause: error}),
            );
        });
        this.worker.on('exit', () => {
            this.rejectAll(new BackendWorkerError('backend-worker-stopped'));
        });
        this.worker.stdout.resume();
        this.worker.stderr.resume();
    }

    async open(password: string): Promise<void> {
        await this.request('open', password);
    }
    async identity(): Promise<string> {
        const identity = await this.request('identity');
        if (typeof identity !== 'string' || !/^[A-Z0-9*][A-Z0-9]{7}$/.test(identity))
            throw new BackendWorkerError('invalid-backend-identity');
        return identity;
    }
    async conversations(): Promise<ConversationSummary[]> {
        return parseConversations(await this.request('conversations'));
    }
    async markRead(request: ReadCommand): Promise<void> {
        await this.request('mark-read', undefined, parseReadCommand(request));
    }
    async profilePicture(identity: string): Promise<Uint8Array | null> {
        return parseProfilePicture(
            await this.request('profile-picture', undefined, pictureIdentity(identity)),
        );
    }
    async directory(): Promise<DirectorySnapshot> {
        return parseDirectory(await this.request('directory'));
    }
    async reactMessage(request: NodeReactionRequest): Promise<void> {
        await this.request('react-message', undefined, parseReactionCommand(request));
    }
    async reactionState(request: NodeReactionRequest): Promise<boolean> {
        const value = await this.request(
            'reaction-state',
            undefined,
            parseReactionCommand(request),
        );
        if (typeof value !== 'boolean') throw new Error('Invalid reaction state');
        return value;
    }
    async ensureContact(input: string): Promise<DirectorySnapshot['contacts'][number]> {
        if (!/^[A-Za-z0-9*][A-Za-z0-9]{7}$/.test(input))
            throw new Error('Invalid contact identity');
        const identity = input.toUpperCase();
        const value = await this.request('ensure-contact', undefined, identity);
        const contact = parseDirectory({contacts: [value], groups: []}).contacts[0]!;
        if (contact.identity !== identity) throw new Error('Contact identity mismatch');
        return contact;
    }
    async watchTyping(
        chatId: string,
        changed: (typing: boolean) => void,
    ): Promise<() => Promise<void>> {
        const channel = new MessageChannel();
        const subscription = receiveConnection(channel.port1, changed);
        try {
            await this.request('watch-typing', undefined, {chatId, port: channel.port2}, [
                channel.port2,
            ]);
            return subscription.stop;
        } catch (error) {
            subscription.dispose();
            channel.port2.close();
            throw error;
        }
    }
    async watchConnection(changed: (connected: boolean) => void): Promise<() => Promise<void>> {
        const channel = new MessageChannel();
        const subscription = receiveConnection(channel.port1, changed);
        try {
            await this.request('watch-connection', undefined, {port: channel.port2}, [
                channel.port2,
            ]);
            return subscription.stop;
        } catch (error) {
            subscription.dispose();
            channel.port2.close();
            throw error;
        }
    }
    async watchTopology(onReset: () => void): Promise<() => Promise<void>> {
        const channel = new MessageChannel();
        const subscription = receiveTopology(channel.port1, onReset);
        try {
            await this.request('watch-topology', undefined, {port: channel.port2}, [channel.port2]);
            return subscription.stop;
        } catch (error) {
            subscription.dispose();
            channel.port2.close();
            throw error;
        }
    }
    async watchMessages(
        chatId: string,
        consume: (message: NormalizedNodeMessage) => Promise<void>,
        onReset: () => void,
    ): Promise<() => Promise<void>> {
        parseHistoryRequest({chatId, limit: 1});
        const channel = new MessageChannel();
        const subscription = receiveMessages(channel.port1, chatId, consume, onReset);
        try {
            await this.request('watch-messages', undefined, {chatId, port: channel.port2}, [
                channel.port2,
            ]);
            return subscription.stop;
        } catch (error) {
            subscription.dispose();
            channel.port2.close();
            throw error;
        }
    }
    async prepareFile(
        value: PrepareFileRequest,
        source: Readable,
        signal?: AbortSignal,
    ): Promise<string> {
        let channel: MessageChannel | undefined;
        let serving: Promise<void> | undefined;
        try {
            const request = parsePrepareFile(value);
            signal?.throwIfAborted();
            this.preparationStreams.add(source);
            channel = new MessageChannel();
            serving = serveByteStream(channel.port1, source, {bytes: request.bytes, signal});
            const token = await this.request(
                'prepare-file',
                undefined,
                {request, port: channel.port2},
                [channel.port2],
            );
            signal?.throwIfAborted();
            return parsePreparedToken(token);
        } finally {
            this.preparationStreams.delete(source);
            source.destroy();
            channel?.port1.close();
            channel?.port2.close();
            await serving;
        }
    }
    async discardPreparedFile(request: DiscardPreparedFile): Promise<boolean> {
        const value = await this.request(
            'discard-prepared-file',
            undefined,
            parseDiscardPreparedFile(request),
        );
        if (typeof value !== 'boolean') throw new Error('Invalid prepared file discard result');
        return value;
    }
    async sendPreparedFile(
        value: PreparedFileSend,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]> {
        const request = parsePreparedFileSend(value);
        const channel = new MessageChannel();
        const allocation = acceptSendAllocation(channel.port1, persist);
        try {
            return allocation.result(
                await this.request(
                    'send-prepared-file',
                    undefined,
                    {request, port: channel.port2},
                    [channel.port2],
                ),
            );
        } finally {
            allocation.close();
            channel.port2.close();
        }
    }
    async setTyping(value: NodeTypingRequest): Promise<void> {
        await this.request('set-typing', undefined, parseTypingCommand(value));
    }
    async mutationState(value: NodeMutationRequest): Promise<boolean> {
        const result = await this.request('mutation-state', undefined, parseMutationCommand(value));
        if (typeof result !== 'boolean') throw new Error('Invalid mutation state response');
        return result;
    }
    async mutateMessage(value: NodeMutationRequest): Promise<void> {
        await this.request('mutate-message', undefined, parseMutationCommand(value));
    }
    async sendPreparedVideo(
        value: PreparedVideoSend,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]> {
        const request = parsePreparedVideoSend(value);
        const channel = new MessageChannel();
        const allocation = acceptSendAllocation(channel.port1, persist);
        try {
            return allocation.result(
                await this.request(
                    'send-prepared-video',
                    undefined,
                    {request, port: channel.port2},
                    [channel.port2],
                ),
            );
        } finally {
            allocation.close();
            channel.port2.close();
        }
    }
    async sendPreparedImage(
        value: PreparedImageSend,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]> {
        const request = parsePreparedImageSend(value);
        const channel = new MessageChannel();
        const allocation = acceptSendAllocation(channel.port1, persist);
        try {
            return allocation.result(
                await this.request(
                    'send-prepared-image',
                    undefined,
                    {request, port: channel.port2},
                    [channel.port2],
                ),
            );
        } finally {
            allocation.close();
            channel.port2.close();
        }
    }
    async sendText(
        value: TextSendRequest,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]> {
        const request = parseTextSend(value);
        const channel = new MessageChannel();
        const allocation = acceptSendAllocation(channel.port1, persist);
        try {
            return allocation.result(
                await this.request('send-text', undefined, {request, port: channel.port2}, [
                    channel.port2,
                ]),
            );
        } finally {
            allocation.close();
            channel.port2.close();
        }
    }
    async mediaLimits(): Promise<{maximumBytes: number}> {
        const value = (await this.request('media-limits')) as {maximumBytes?: unknown} | null;
        if (
            !value ||
            typeof value.maximumBytes !== 'number' ||
            !Number.isSafeInteger(value.maximumBytes) ||
            value.maximumBytes < 1
        )
            throw new BackendWorkerError('invalid-media-limit');
        return {maximumBytes: value.maximumBytes};
    }
    async mediaInfo(value: MediaRequest): Promise<MediaInfo> {
        const request = parseMediaRequest(value);
        return parseMediaInfo(
            await this.request('media-info', undefined, request),
            request.maximumBytes,
        );
    }
    async mediaStream(
        value: MediaRequest,
        expectedValue: MediaInfo,
        signal?: AbortSignal,
    ): Promise<Readable> {
        const request = parseMediaRequest(value),
            expected = parseMediaInfo(expectedValue, request.maximumBytes);
        signal?.throwIfAborted();
        const channel = new MessageChannel();
        const abort = () => channel.port1.close();
        signal?.addEventListener('abort', abort, {once: true});
        try {
            const result = parseMediaInfo(
                await this.request(
                    'media-stream',
                    undefined,
                    {request, expected, port: channel.port2},
                    [channel.port2],
                ),
                request.maximumBytes,
            );
            signal?.throwIfAborted();
            if (
                result.bytes !== expected.bytes ||
                result.sha256 !== expected.sha256 ||
                result.mimeType !== expected.mimeType
            )
                throw new Error('Media stream descriptor mismatch');
            return receiveByteStream(channel.port1, {bytes: result.bytes, signal});
        } catch (error) {
            channel.port1.close();
            channel.port2.close();
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
        }
    }
    async history(chatId: string, limit = 100, after?: HistoryCursor): Promise<HistoryPage> {
        const request = parseHistoryRequest({chatId, limit, after});
        return parseHistoryPage(await this.request('history', undefined, request), request);
    }
    async link(): Promise<void> {
        await this.request('link');
    }
    async providePassword(password: string): Promise<void> {
        await this.request('password', password);
    }
    async stop(): Promise<void> {
        if (this.stopping) return await this.stopping;
        if (this.gracefulStop) return await this.gracefulStop;
        this.draining = true;
        for (const stream of this.preparationStreams) stream.destroy();
        this.gracefulStop = this.finishGracefulStop();
        await this.gracefulStop;
    }
    private async finishGracefulStop(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                this.request('close-prepared-files'),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 2000);
                }),
            ]);
        } catch {
            // Preparation cleanup cannot prevent worker termination after an outage.
        } finally {
            clearTimeout(timer);
            await this.stopWithError(new BackendWorkerError('backend-worker-stopped'));
        }
    }

    private async request(
        command: string,
        password?: string,
        data?: unknown,
        transferList?: Transferable[],
    ): Promise<unknown> {
        await this.ready;
        if (this.stopped || (this.draining && command !== 'close-prepared-files'))
            throw new BackendWorkerError('backend-worker-stopped');
        const id = this.nextId++;
        return await new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            try {
                this.worker.postMessage({id, command, password, data}, transferList);
            } catch (error) {
                this.pending.delete(id);
                reject(error as Error);
            }
        });
    }
    private rejectAll(error: Error): void {
        this.stopped = true;
        this.readyReject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
    private stopWithError(error: Error): Promise<void> {
        if (!this.stopping) {
            this.rejectAll(error);
            this.stopping = this.worker.terminate().then(() => undefined);
        }
        return this.stopping;
    }
}
