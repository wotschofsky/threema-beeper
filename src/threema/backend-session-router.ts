import {parseReadCommand, type ReadCommand} from './read-command.ts';
import {parseProfilePicture, pictureIdentity} from './profile-picture.ts';
import {serveConnection} from './connection-subscription.ts';
import {parseTypingCommand, type NodeTypingRequest} from './typing-command.ts';
import {parseMutationCommand, type NodeMutationRequest} from './mutation-command.ts';
import {parsePreparedImageSend, type PreparedImageSend} from './prepared-image-send.ts';
import {parsePreparedVideoSend, type PreparedVideoSend} from './prepared-video-send.ts';
import {parseDiscardPreparedFile, type DiscardPreparedFile} from './prepare-file-command.ts';
import {parsePreparedFileSend, type PreparedFileSend} from './prepared-file-send.ts';
import {prepareFileFromPort, type PrepareFileRequest} from './prepare-file-command.ts';
import {
    SendAllocation,
    parseTextSend,
    parseAllocatedIds,
    type TextSendRequest,
} from './send-allocation.ts';
import type {Readable} from 'node:stream';
import {MediaCommands, type MediaRequest, type MediaInfo} from './media-commands.ts';
import {parseHistoryRequest, parseHistoryPage, type HistoryCursor} from './history.ts';
import {MessagePort} from 'node:worker_threads';
import {serveMessages} from './message-subscription.ts';
import {serveTopology} from './topology-subscription.ts';
import {parseDirectory} from './directory.ts';
import {parseReactionCommand, type NodeReactionRequest} from './reaction-command.ts';
import type {NormalizedNodeMessage} from './history.ts';

export interface BackendSession {
    markRead(request: ReadCommand): Promise<void>;
    watchTyping(chatId: string, changed: (typing: boolean) => void): Promise<() => Promise<void>>;
    watchConnection(changed: (connected: boolean) => void): Promise<() => Promise<void>>;
    setTyping(request: NodeTypingRequest): Promise<void>;
    mutationState(request: NodeMutationRequest): Promise<boolean>;
    mutateMessage(request: NodeMutationRequest): Promise<void>;
    sendPreparedVideo(
        request: PreparedVideoSend,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]>;
    discardPreparedFile(request: DiscardPreparedFile): Promise<boolean>;
    sendPreparedFile(
        request: PreparedFileSend,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]>;
    sendPreparedImage(
        request: PreparedImageSend,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]>;
    closePreparedFiles(): Promise<void>;
    prepareFile(request: PrepareFileRequest, source: AsyncIterable<Uint8Array>): Promise<string>;

    sendText(
        request: TextSendRequest,
        persist: (ids: readonly string[]) => Promise<void>,
    ): Promise<readonly string[]>;
    media(
        request: MediaRequest,
        signal?: AbortSignal,
    ): Promise<MediaInfo & {open(signal?: AbortSignal): Readable}>;
    open(password: string): Promise<void>;
    link(): Promise<void>;
    providePassword(password: string): void;
    identity(): Promise<string>;
    conversations(): Promise<unknown>;
    directory(): Promise<unknown>;
    profilePicture?(identity: string): Promise<Uint8Array | null>;
    ensureContact(identity: string): Promise<unknown>;
    reactMessage(request: NodeReactionRequest): Promise<void>;
    reactionState(request: NodeReactionRequest): Promise<boolean>;
    watchTopology(reset: () => void): Promise<() => Promise<void>>;
    history(chatId: string, limit: number, after?: HistoryCursor): Promise<unknown>;
    watchMessages(
        chatId: string,
        consume: (message: NormalizedNodeMessage) => Promise<void>,
        reset: () => void,
    ): Promise<() => Promise<void>>;
}

/** Shared production worker command routing; the session owns native profile state. */
export function serveBackendSession(
    port: MessagePort,
    session: BackendSession,
    mediaLimits: () => {maximumBytes: number},
): void {
    const media = new MediaCommands((request, signal) => session.media(request, signal));
    const subscriptions = new Set<MessagePort>();
    port.on('message', (message: unknown) => {
        void (async () => {
            if (!message || typeof message !== 'object') return;
            const request = message as {
                id?: unknown;
                command?: unknown;
                password?: unknown;
                data?: unknown;
            };
            if (!Number.isSafeInteger(request.id)) return;
            const id = request.id;
            try {
                let value: unknown;
                switch (request.command) {
                    case 'discard-prepared-file':
                        value = await session.discardPreparedFile(
                            parseDiscardPreparedFile(request.data),
                        );
                        break;
                    case 'close-prepared-files':
                        await session.closePreparedFiles();
                        break;
                    case 'prepare-file':
                        value = await prepareFileFromPort(session, request.data);
                        break;
                    case 'send-prepared-video':
                    case 'send-prepared-image':
                    case 'send-prepared-file':
                    case 'send-text': {
                        const data = request.data as
                            | {request?: unknown; port?: unknown}
                            | undefined;
                        if (!(data?.port instanceof MessagePort))
                            throw new Error('Invalid send port');
                        const allocation = new SendAllocation(data.port);
                        try {
                            value = parseAllocatedIds(
                                request.command === 'send-prepared-video'
                                    ? await session.sendPreparedVideo(
                                          parsePreparedVideoSend(data.request),
                                          (ids) => allocation.record(ids),
                                      )
                                    : request.command === 'send-prepared-image'
                                      ? await session.sendPreparedImage(
                                            parsePreparedImageSend(data.request),
                                            (ids) => allocation.record(ids),
                                        )
                                      : request.command === 'send-prepared-file'
                                        ? await session.sendPreparedFile(
                                              parsePreparedFileSend(data.request),
                                              (ids) => allocation.record(ids),
                                          )
                                        : await session.sendText(
                                              parseTextSend(data.request),
                                              (ids) => allocation.record(ids),
                                          ),
                            );
                        } finally {
                            allocation.close();
                        }
                        break;
                    }
                    case 'media-limits':
                        value = mediaLimits();
                        break;
                    case 'media-info':
                        value = await media.info(request.data);
                        break;
                    case 'media-stream': {
                        const data = request.data as
                            | {request?: unknown; expected?: unknown; port?: unknown}
                            | undefined;
                        if (!(data?.port instanceof MessagePort))
                            throw new Error('Invalid media port');
                        value = await media.stream(data.request, data.expected, data.port);
                        break;
                    }
                    case 'mark-read':
                        await session.markRead(parseReadCommand(request.data));
                        break;
                    case 'set-typing':
                        await session.setTyping(parseTypingCommand(request.data));
                        break;
                    case 'mutation-state':
                        value = await session.mutationState(parseMutationCommand(request.data));
                        break;
                    case 'mutate-message':
                        await session.mutateMessage(parseMutationCommand(request.data));
                        break;
                    case 'react-message':
                        await session.reactMessage(parseReactionCommand(request.data));
                        break;
                    case 'reaction-state':
                        value = await session.reactionState(parseReactionCommand(request.data));
                        break;
                    case 'ensure-contact': {
                        if (
                            typeof request.data !== 'string' ||
                            !/^[A-Z0-9*][A-Z0-9]{7}$/.test(request.data)
                        )
                            throw new Error('Invalid contact identity');
                        value = parseDirectory({
                            contacts: [await session.ensureContact(request.data)],
                            groups: [],
                        }).contacts[0];
                        break;
                    }
                    case 'profile-picture':
                        if (!session.profilePicture)
                            throw new Error('Contact pictures unavailable');
                        value = parseProfilePicture(
                            await session.profilePicture(pictureIdentity(request.data)),
                        );
                        break;
                    case 'directory':
                        value = parseDirectory(await session.directory());
                        break;
                    case 'watch-typing': {
                        const chatId = (request.data as {chatId?: unknown} | undefined)?.chatId;
                        if (typeof chatId !== 'string' || !/^c:[A-Z0-9*][A-Z0-9]{7}$/.test(chatId))
                            throw new Error('Invalid typing conversation');
                        const stream = (request.data as {port?: unknown} | undefined)?.port;
                        if (!(stream instanceof MessagePort))
                            throw new Error('Invalid subscription port');
                        if (subscriptions.size >= 1024) {
                            stream.close();
                            throw new Error('Too many subscriptions');
                        }
                        subscriptions.add(stream);
                        stream.once('close', () => subscriptions.delete(stream));
                        await serveConnection(stream, (changed) =>
                            session.watchTyping(chatId, changed),
                        );
                        break;
                    }
                    case 'watch-connection': {
                        const stream = (request.data as {port?: unknown} | undefined)?.port;
                        if (!(stream instanceof MessagePort))
                            throw new Error('Invalid subscription port');
                        if (subscriptions.size >= 1024) {
                            stream.close();
                            throw new Error('Too many subscriptions');
                        }
                        subscriptions.add(stream);
                        stream.once('close', () => subscriptions.delete(stream));
                        await serveConnection(stream, (changed) =>
                            session.watchConnection(changed),
                        );
                        break;
                    }
                    case 'watch-topology': {
                        const stream = (request.data as {port?: unknown} | undefined)?.port;
                        if (!(stream instanceof MessagePort))
                            throw new Error('Invalid subscription port');
                        if (subscriptions.size >= 1024) {
                            stream.close();
                            throw new Error('Too many subscriptions');
                        }
                        subscriptions.add(stream);
                        stream.once('close', () => subscriptions.delete(stream));
                        await serveTopology(stream, (reset) => session.watchTopology(reset));
                        break;
                    }
                    case 'watch-messages': {
                        const input = request.data as
                            | {chatId?: unknown; port?: unknown}
                            | undefined;
                        const chat = parseHistoryRequest({chatId: input?.chatId, limit: 1}).chatId;
                        if (!(input?.port instanceof MessagePort))
                            throw new Error('Invalid subscription port');
                        const stream = input.port;
                        if (subscriptions.size >= 1024) {
                            stream.close();
                            throw new Error('Too many subscriptions');
                        }
                        subscriptions.add(stream);
                        stream.once('close', () => subscriptions.delete(stream));
                        await serveMessages(stream, chat, (consume, reset) =>
                            session.watchMessages(chat, consume, reset),
                        );
                        break;
                    }
                    case 'history': {
                        const input = parseHistoryRequest(request.data);
                        value = parseHistoryPage(
                            await session.history(input.chatId, input.limit, input.after),
                            input,
                        );
                        break;
                    }
                    case 'conversations':
                        value = await session.conversations();
                        break;
                    case 'identity':
                        value = await session.identity();
                        break;
                    case 'open':
                    case 'password':
                        if (
                            typeof request.password !== 'string' ||
                            request.password.length < 1 ||
                            request.password.length > 4096
                        )
                            throw new Error('Invalid password');
                        if (request.command === 'open') await session.open(request.password);
                        else session.providePassword(request.password);
                        break;
                    case 'link':
                        await session.link();
                        break;
                    default:
                        throw new Error('Unknown command');
                }
                port.postMessage({type: 'result', id, value});
            } catch (error) {
                if (
                    request.command === 'watch-messages' ||
                    request.command === 'watch-topology' ||
                    request.command === 'watch-connection' ||
                    request.command === 'watch-typing'
                ) {
                    const stream = (request.data as {port?: unknown} | undefined)?.port;
                    if (stream instanceof MessagePort) stream.close();
                }
                let category =
                    error && typeof error === 'object' && 'type' in error ? error.type : undefined;
                const mediaErrors = [
                    'MEDIA_NOT_CACHED',
                    'MEDIA_TOO_LARGE',
                    'MEDIA_MESSAGE_NOT_FOUND',
                    'MEDIA_CONVERSATION_NOT_FOUND',
                    'MEDIA_MESSAGE_UNSUPPORTED',
                    'MEDIA_METADATA_MISSING',
                    'MEDIA_SIZE_MISMATCH',
                ];
                if (
                    (request.command === 'media-info' || request.command === 'media-stream') &&
                    error instanceof Error &&
                    mediaErrors.includes(error.message)
                )
                    category = error.message;
                const allowed = [
                    ...(request.command === 'mutation-state'
                        ? ['mutation-invalid', 'mutation-permission-denied']
                        : []),
                    ...(request.command === 'mutate-message'
                        ? [
                              'mutation-invalid',
                              'mutation-permission-denied',
                              'mutation-not-found',
                              'mutation-unsupported',
                              'edit-window-expired',
                              'delete-window-expired',
                          ]
                        : []),
                    ...(request.command === 'react-message'
                        ? ['reaction-invalid', 'reaction-permission-denied', 'reaction-not-found']
                        : []),
                    ...(request.command === 'ensure-contact'
                        ? ['contact-unavailable', 'contact-is-self']
                        : []),
                    ...mediaErrors,
                    'no-identity',
                    'key-storage-error',
                    'key-storage-error-wrong-password',
                    'handled-linking-error',
                ];
                port.postMessage({
                    type: 'error',
                    id,
                    code:
                        typeof category === 'string' && allowed.includes(category)
                            ? category
                            : 'backend-operation-failed',
                });
            }
        })();
    });
    port.postMessage({type: 'initialized'});
}
