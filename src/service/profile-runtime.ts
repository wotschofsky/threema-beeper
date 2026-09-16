import {SendFailureNotices} from '../outbox/send-failure-notices.ts';
import {ownerReadEvents, OwnerReadReceipts} from '../matrix/owner-read-receipts.ts';
import {IncomingTyping} from '../matrix/incoming-typing.ts';
import {TypingRuntime} from '../outbox/typing-runtime.ts';
import {UnsupportedNoticeWorker} from '../outbox/unsupported-notices.ts';
import {createMutationRuntime} from '../outbox/mutation-runtime.ts';
import {createReactionRuntime} from '../outbox/reaction-runtime.ts';
import {createMediaRuntime} from '../outbox/media-runtime.ts';
import type {createFilePreparation} from '../media/file-preparation.ts';
import type {createImagePreparation} from '../media/image-preparation.ts';
import type {createVideoPreparation} from '../media/video-download.ts';
import type {createAudioPreparation} from '../media/audio-staging.ts';
import {RedactionSender} from '../matrix/redaction-sender.ts';
import {DispatchGuard} from '../outbox/dispatch-guard.ts';
import {EncryptedSender} from '../matrix/encrypted-sender.ts';
import {StateEventWorker} from '../matrix/state-event-worker.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import {ProfileSynchronizer} from '../threema/profile-sync.ts';
import type {MessageJournal} from '../threema/message-journal.ts';
import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {TransactionDecoder} from '../matrix/transaction-worker.ts';
import {TransactionWorker} from '../matrix/transaction-worker.ts';
import {TransactionPump} from '../matrix/transaction-pump.ts';
import {JournalDelivery} from '../matrix/journal-delivery.ts';
import {MatrixJournalSink, type BridgeIntent} from '../matrix/journal-sink.ts';
import type {EncryptedIntent} from '../matrix/encrypted-sender.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import type {OutboxStore} from '../outbox/store.ts';
import {createOutboundDispatcher} from '../outbox/runtime.ts';
import type {OutboxDispatcher} from '../outbox/dispatcher.ts';
import {reconcileRetainedConfirmations} from '../outbox/reconcile-retained.ts';

type Backend = Pick<
    BackendController,
    | 'identity'
    | 'stop'
    | 'watchTopology'
    | 'directory'
    | 'conversations'
    | 'watchMessages'
    | 'history'
    | 'sendText'
> &
    Partial<
        Pick<
            BackendController,
            | 'markRead'
            | 'watchTyping'
            | 'watchConnection'
            | 'setTyping'
            | 'reactMessage'
            | 'mutateMessage'
            | 'mutationState'
            | 'profilePicture'
            | 'reactionState'
            | 'sendPreparedFile'
            | 'sendPreparedImage'
            | 'sendPreparedVideo'
        >
    >;
export interface ProfileRuntimeOptions {
    /** Reduced feature set: contact text/replies only. */
    textOnly?: boolean;
    /** Opt into additional features independently. Typing stays disabled. */
    includeGroups?: boolean;
    includeMedia?: boolean;
    includeReactions?: boolean;
    includeMutations?: boolean;
    includeReceipts?: boolean;
    sendOwnerReadReceipt?: (room: string, event: string) => Promise<void>;
    protocolAvatar?: string;
    joinOwnerRoom?: (room: string) => Promise<void>;
    profile: string;
    owner: string;
    domain: string;
    namespace?: string;
    /** Already opened and exclusively owned. This runtime terminates it on stop. */
    backend: Backend;
    journal: MessageJournal;
    inbox: TransactionInbox;
    outbox: OutboxStore;
    portals: PortalStore;
    bot: BridgeIntent;
    getIntent: (mxid: string) => BridgeIntent;
    getOwnerIntent?: () => Promise<EncryptedIntent>;
    decode: TransactionDecoder;
    handleState?: (event: import('../matrix/transaction-inbox.ts').InboxEvent) => Promise<boolean>;
    /** Native Matrix crypto identity/session must already be available. */
    matrixReady: () => boolean;
    mutations?: {
        createOriginalLoader: (
            signal: AbortSignal,
        ) => Parameters<typeof createMutationRuntime>[0]['original'];
    };
    assertPortalAlias?: (alias: string) => void;
    renderMedia?: (message: NormalizedNodeMessage) => Promise<Record<string, unknown>>;
    renderOwnerMedia?: (message: NormalizedNodeMessage) => Promise<Record<string, unknown>>;
    files?: {
        maximumBytes: number;
        createPreparation: (signal: AbortSignal) => ReturnType<typeof createFilePreparation>;
        createImagePreparation?: (signal: AbortSignal) => ReturnType<typeof createImagePreparation>;
        createVideoPreparation?: (signal: AbortSignal) => ReturnType<typeof createVideoPreparation>;
        createAudioPreparation?: (signal: AbortSignal) => ReturnType<typeof createAudioPreparation>;
    };
    intervalMs?: number;
    sync?: {pageSize: number; periodicMs: number; maxBufferedEvents?: number};
    management?: (runtime: ProfileRuntime) => {drain(limit: number): Promise<number>};
    connectionChanged?: (connected: boolean) => void;
}

/** Own processing loops for one opened profile; callers close stores after stop resolves. */
export class ProfileRuntime {
    private readonly options: ProfileRuntimeOptions;
    private readonly sync: ProfileSynchronizer;
    private readonly inbound: JournalDelivery;
    private readonly outbound: OutboxDispatcher;
    private readonly transactions: TransactionPump;
    private readonly stateEvents: TransactionPump;
    private readonly notices: TransactionPump;
    private readonly failures: TransactionPump;
    private readonly management?: TransactionPump;
    private readonly reactions?: TransactionPump;
    private readonly receipts?: TransactionPump;
    private readonly mutations?: TransactionPump;
    private connected = false;
    private stopConnection?: () => Promise<void>;
    private readonly incomingTyping?: IncomingTyping;
    private readonly incomingTypingPump?: TransactionPump;
    private readonly typing?: TypingRuntime;
    private readonly typingPump?: TransactionPump;
    private readonly mutationAbort = new AbortController();
    private readonly files?: TransactionPump;
    private readonly mediaAbort = new AbortController();
    private state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' = 'idle';
    private starting?: Promise<void>;
    private stopping?: Promise<void>;
    constructor(options: ProfileRuntimeOptions) {
        this.options = options;
        const intervalMs = options.intervalMs ?? 1000;
        this.sync = new ProfileSynchronizer(options.backend, options.journal, {
            ...options.sync,
            contactOnly: options.textOnly && !options.includeGroups,
            onReconciled: (signal) =>
                reconcileRetainedConfirmations(options.profile, options.outbox, options.journal, signal),
        });
        const ready = () =>
            this.state === 'running' && this.sync.readyForMessages && options.matrixReady();
        this.inbound = new JournalDelivery(
            options.journal,
            new MatrixJournalSink({
                textOnly: options.textOnly,
                includeGroups: options.includeGroups,
                includeMedia: options.includeMedia,
                includeReactions: options.includeReactions,
                includeMutations: options.includeMutations,
                includeReceipts: options.includeReceipts,
                sendOwnerReadReceipt: options.sendOwnerReadReceipt,
                profilePicture: options.backend.profilePicture
                    ? (identity) => options.backend.profilePicture!(identity)
                    : undefined,
                protocolAvatar: options.protocolAvatar,
                joinOwnerRoom: options.joinOwnerRoom,
                profile: options.profile,
                owner: options.owner,
                domain: options.domain,
                namespace: options.namespace,
                store: options.portals,
                outbox: options.outbox,
                bot: options.bot,
                getIntent: options.getIntent,
                getOwnerIntent: options.getOwnerIntent,
                metadata: () => options.journal.metadata(),
                renderMedia: options.renderMedia,
                renderOwnerMedia: options.renderOwnerMedia,
                ownerReactionState: options.backend.reactionState
                    ? (chatId, messageId, emoji) =>
                          options.backend.reactionState!({
                              profile: options.profile,
                              chatId,
                              messageId,
                              emoji,
                              action: 'apply',
                          })
                    : undefined,
                assertPortalAlias: options.assertPortalAlias,
            }),
            ready,
            intervalMs,
        );
        this.outbound = createOutboundDispatcher({
            profile: options.profile,
            owner: options.owner,
            portals: options.portals,
            bot: options.bot,
            backend: options.backend,
            inbox: options.inbox,
            outbox: options.outbox,
            ready: () =>
                ready() &&
                options.journal.metadata() !== undefined &&
                !options.journal.metadata(true),
            intervalMs,
        });
        const noticeSender = new EncryptedSender(options.bot, options.portals);
        const noticeGuard = new DispatchGuard(options);
        if (!options.textOnly && options.backend.setTyping) {
            if (!options.backend.watchConnection)
                throw new Error('Typing requires connection monitoring');
            this.typing = new TypingRuntime({
                ...options,
                ready: () =>
                    this.connected &&
                    ready() &&
                    options.journal.metadata() !== undefined &&
                    !options.journal.metadata(true),
                authorize: (roomId, chatId) =>
                    noticeGuard.check({
                        roomId,
                        chatId,
                        profile: options.profile,
                        sender: options.owner,
                    }),
                setTyping: (request) => options.backend.setTyping!(request),
            });
            this.typingPump = new TransactionPump(this.typing, {
                intervalMs: Math.min(intervalMs, 1000),
            });
        }
        if (!options.textOnly && options.backend.watchTyping) {
            if (!options.backend.watchConnection)
                throw new Error('Typing requires connection monitoring');
            this.incomingTyping = new IncomingTyping({
                chats: () => options.journal.metadata()?.chats.map((chat) => chat.chatId) ?? [],
                ready: () =>
                    this.connected &&
                    ready() &&
                    options.journal.metadata() !== undefined &&
                    !options.journal.metadata(true),
                watch: (chat, changed) => options.backend.watchTyping!(chat, changed),
                send: async (chat, typing, current) => {
                    const room = options.portals.get(options.profile, chat);
                    const ghost = options.portals.ghost(options.profile, chat.slice(2));
                    if (!room || !ghost) throw new Error('Typing portal unavailable');
                    await noticeGuard.check({
                        roomId: room,
                        chatId: chat,
                        profile: options.profile,
                        sender: options.owner,
                    });
                    if (!this.connected || !ready() || !current()) return false;
                    if (
                        options.portals.get(options.profile, chat) !== room ||
                        options.portals.ghost(options.profile, chat.slice(2)) !== ghost
                    )
                        return false;
                    const intent = options.getIntent(ghost);
                    if (intent.userId !== ghost) throw new Error('Typing sender mismatch');
                    await intent.underlyingClient.setTyping(room, typing, 10000);
                    return true;
                },
            });
            this.incomingTypingPump = new TransactionPump(this.incomingTyping, {
                intervalMs: Math.min(intervalMs, 1000),
            });
        }
        if ((!options.textOnly || options.includeMedia) && options.files) {
            if (options.files.createVideoPreparation && !options.backend.sendPreparedVideo)
                throw new Error('Video preparation requires native video sending');
            if (options.files.createImagePreparation && !options.backend.sendPreparedImage)
                throw new Error('Image preparation requires native image sending');
            if (!options.backend.sendPreparedFile || !options.renderMedia)
                throw new Error('File sending requires backend support and media echo rendering');
            this.files = new TransactionPump(
                createMediaRuntime({
                    ...options,
                    maximumBytes: options.files.maximumBytes,
                    attachmentReplies: true,
                    backend: {
                        sendText: (request, persist) => options.backend.sendText(request, persist),
                        sendPreparedFile: (request, persist) =>
                            options.backend.sendPreparedFile!(request, persist),
                    },
                    prepare: options.files.createPreparation(this.mediaAbort.signal),
                    videos: options.files.createVideoPreparation
                        ? {
                              prepare: options.files.createVideoPreparation(this.mediaAbort.signal),
                              send: (request, persist) =>
                                  options.backend.sendPreparedVideo!(request, persist),
                          }
                        : undefined,
                    audio: options.files.createAudioPreparation
                        ? {
                              prepare: options.files.createAudioPreparation(this.mediaAbort.signal),
                          }
                        : undefined,
                    images: options.files.createImagePreparation
                        ? {
                              prepare: options.files.createImagePreparation(this.mediaAbort.signal),
                              send: (request, persist) =>
                                  options.backend.sendPreparedImage!(request, persist),
                          }
                        : undefined,
                    ready: () =>
                        ready() &&
                        options.journal.metadata() !== undefined &&
                        !options.journal.metadata(true),
                }),
                {intervalMs},
            );
        }
        if (
            (!options.textOnly || options.includeReactions) &&
            options.backend.reactMessage &&
            options.backend.reactionState
        ) {
            const reactionRedactor = new RedactionSender(options.portals, options.bot);
            this.reactions = new TransactionPump(
                createReactionRuntime({
                    ...options,
                    backend: {
                        reactMessage: (request) => options.backend.reactMessage!(request),
                        reactionState: (request) => options.backend.reactionState!(request),
                    },
                    ready: () =>
                        ready() &&
                        options.journal.metadata() !== undefined &&
                        !options.journal.metadata(true),
                    send: (id, room, content) =>
                        noticeSender.send(id, room, 'm.room.message', content),
                    redact: (id, room, event) => reactionRedactor.redact(id, room, event),
                }),
                {intervalMs},
            );
        }
        if ((!options.textOnly || options.includeMutations) && options.mutations) {
            if (!options.backend.mutateMessage || !options.backend.mutationState)
                throw new Error('Mutation processing requires native mutation support');
            this.mutations = new TransactionPump(
                createMutationRuntime({
                    ...options,
                    backend: {
                        mutateMessage: (request) => options.backend.mutateMessage!(request),
                        mutationState: (request) => options.backend.mutationState!(request),
                    },
                    original: options.mutations.createOriginalLoader(this.mutationAbort.signal),
                    signal: this.mutationAbort.signal,
                    ready: () =>
                        ready() &&
                        options.journal.metadata() !== undefined &&
                        !options.journal.metadata(true),
                    send: (id, room, content) =>
                        noticeSender.send(id, room, 'm.room.message', content),
                }),
                {intervalMs},
            );
        }
        this.notices = new TransactionPump(
            new UnsupportedNoticeWorker({
                inbox: options.inbox,
                outbox: options.outbox,
                portals: options.portals,
                profile: options.profile,
                owner: options.owner,
                ready,
                reactionsEnabled: this.reactions !== undefined,
                mutationsEnabled: this.mutations !== undefined,
                files: this.files
                    ? {
                          maximumBytes: options.files!.maximumBytes,
                          attachmentReplies: true,
                          imagesEnabled: options.files!.createImagePreparation !== undefined,
                          videosEnabled: options.files!.createVideoPreparation !== undefined,
                          audioEnabled: options.files!.createAudioPreparation !== undefined,
                      }
                    : undefined,
                authorize: (roomId, chatId) =>
                    noticeGuard.check({
                        roomId,
                        chatId,
                        profile: options.profile,
                        sender: options.owner,
                    }),
                send: (id, room, content) => noticeSender.send(id, room, 'm.room.message', content),
            }),
            {intervalMs},
        );
        this.failures = new TransactionPump(
            new SendFailureNotices({
                ...options,
                ready,
                authorize: (roomId, chatId) =>
                    noticeGuard.check({
                        profile: options.profile,
                        sender: options.owner,
                        roomId,
                        chatId,
                    }),
                send: (id, room, content) => noticeSender.send(id, room, 'm.room.message', content),
            }),
            {intervalMs: Math.max(intervalMs, 5000)},
        );
        this.stateEvents = new TransactionPump(
            new StateEventWorker(options.inbox, options.handleState ?? (async () => false)),
            {intervalMs},
        );
        if (options.includeReceipts) {
            if (!options.backend.markRead) throw new Error('Read receipts require native support');
            const guard = new DispatchGuard(options);
            this.receipts = new TransactionPump(
                new OwnerReadReceipts({
                    ...options,
                    ready: () => ready() && !options.journal.metadata(true),
                    authorize: (roomId, chatId) =>
                        guard.check({
                            profile: options.profile,
                            sender: options.owner,
                            roomId,
                            chatId,
                        }),
                    markRead: (request) => options.backend.markRead!(request),
                }),
                {intervalMs},
            );
        }
        this.transactions = new TransactionPump(
            new TransactionWorker(options.inbox, async (body, emit) => {
                await options.decode(body, emit);
                if (options.includeReceipts)
                    for (const event of ownerReadEvents(body, options.owner)) await emit(event);
            }),
            {intervalMs},
        );
        if (options.management)
            this.management = new TransactionPump(options.management(this), {intervalMs});
    }
    get status() {
        return {
            state: this.state,
            ready:
                this.state === 'running' &&
                this.sync.readyForMessages &&
                this.options.matrixReady() &&
                this.options.journal.metadata() !== undefined &&
                !this.options.journal.metadata(true),
            synchronization: this.sync.state,
            inbound: this.inbound.status,
            outbound: this.outbound.status,
            transactions: this.transactions.status,
            stateEvents: this.stateEvents.status,
            management: this.management?.status ?? 'disabled',
            reactions: this.reactions?.status ?? 'disabled',
            receipts: this.receipts?.status ?? 'disabled',
            mutations: this.mutations?.status ?? 'disabled',
            typing: this.typingPump?.status ?? 'disabled',
            files: this.files?.status ?? 'disabled',
        };
    }
    /** Only called for freshly accepted authenticated transactions, never durable replay. */
    receiveEphemeral(body: Record<string, unknown>): void {
        const events = body['de.sorunome.msc2409.ephemeral'];
        if (!Array.isArray(events) || events.length > 10000) return;
        for (const event of events) {
            if (
                !event ||
                typeof event !== 'object' ||
                event.type !== 'm.typing' ||
                typeof event.room_id !== 'string' ||
                !event.room_id ||
                event.room_id.length > 1024 ||
                !event.content ||
                typeof event.content !== 'object'
            )
                continue;
            this.typing?.update(event.room_id, event.content.user_ids);
        }
    }
    resync(): boolean {
        return this.state === 'running' && this.sync.resync();
    }
    start(): Promise<void> {
        if (this.state === 'running') return Promise.resolve();
        if (this.state === 'starting') return this.starting!;
        if (this.state !== 'idle')
            return Promise.reject(new Error('Profile runtime cannot restart a terminated backend'));
        this.state = 'starting';
        this.starting = this.activate();
        return this.starting;
    }
    private async activate(): Promise<void> {
        try {
            if ((await this.options.backend.identity()) !== this.options.profile)
                throw new Error('Profile runtime identity mismatch');
            if (this.state !== 'starting') throw new Error('Profile runtime startup cancelled');
            if (!this.options.matrixReady()) throw new Error('Matrix crypto is not ready');
            if (this.typing || this.incomingTyping || this.options.connectionChanged) {
                if (!this.options.backend.watchConnection) throw new Error('Connection monitoring unavailable');
                this.stopConnection = await this.options.backend.watchConnection!((connected) => {
                    this.connected = connected;
                    if (this.state === 'starting' || this.state === 'running')
                        this.options.connectionChanged?.(connected);
                    if (!connected) {
                        this.typing?.clear();
                        this.incomingTyping?.clear();
                    }
                });
                if (this.state !== 'starting') {
                    await this.stopConnection();
                    throw new Error('Profile runtime startup cancelled');
                }
            }
            this.sync.start();
            this.transactions.start();
            this.stateEvents.start();
            this.notices.start();
            this.failures.start();
            this.reactions?.start();
            this.receipts?.start();
            this.mutations?.start();
            this.typingPump?.start();
            this.incomingTypingPump?.start();
            this.files?.start();
            this.management?.start();
            this.inbound.start();
            this.outbound.start();
            this.state = 'running';
        } catch (error) {
            await this.stop();
            throw error;
        }
    }
    stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.state = 'stopping';
        this.connected = false;
        this.typing?.clear();
        this.incomingTyping?.clear();
        this.mediaAbort.abort();
        this.mutationAbort.abort();
        this.stopping = this.shutdown();
        return this.stopping;
    }
    private async shutdown(): Promise<void> {
        try {
            // Drop readiness first, abort every loop, then terminate backend IPC to unblock work.
            const results = await Promise.allSettled([
                this.outbound.stop(),
                this.inbound.stop(),
                this.transactions.stop(),
                this.stateEvents.stop(),
                this.notices.stop(),
                this.failures.stop(),
                this.reactions?.stop(),
                this.receipts?.stop(),
                this.mutations?.stop(),
                this.typingPump?.stop(),
                this.incomingTypingPump?.stop(),
                this.incomingTyping?.stop(),
                this.stopConnection?.(),
                this.files?.stop(),
                this.management?.stop(),
                this.sync.stop(),
                this.options.backend.stop(),
            ]);
            if (results.some((result) => result.status === 'rejected'))
                throw new Error('Profile runtime shutdown failed');
        } finally {
            this.state = 'stopped';
        }
    }
}
