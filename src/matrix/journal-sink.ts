import {hasOutboundDeliveryEvidence} from '../outbox/delivery-evidence.ts';
import {syncContactPicture} from './contact-picture.ts';
import {DispatchGuard} from '../outbox/dispatch-guard.ts';
import type {OutboxStore} from '../outbox/store.ts';
import {reconcileOutboundEcho} from '../outbox/echo.ts';
import type {Intent} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/appservice/Intent.js';
import {decodeMetadata, encodeMetadata, type ProfileMetadata} from '../threema/metadata-codec.ts';
import {decodeMessage, encodeMessage} from '../threema/message-codec.ts';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import type {ConversationSummary} from '../threema/conversations.ts';
import {PortalManager} from './portals.ts';
import {GhostManager, ghostUserId} from './ghosts.ts';
import {EncryptedSender, type EncryptedIntent} from './encrypted-sender.ts';
import {StatusDelivery} from './status-delivery.ts';
import {DeletionDelivery} from './deletion-delivery.ts';
import {ReactionDelivery} from './reaction-delivery.ts';
import {RedactionSender} from './redaction-sender.ts';
import {MessageDelivery} from './message-delivery.ts';
import type {PortalStore} from './portal-store.ts';
import type {JournalSink} from './journal-delivery.ts';

export type BridgeIntent = Pick<
    Intent,
    | 'userId'
    | 'underlyingClient'
    | 'ensureRegistered'
    | 'enableEncryption'
    | 'joinRoom'
    | 'leaveRoom'
>;
interface Options {
    textOnly?: boolean;
    includeGroups?: boolean;
    includeMedia?: boolean;
    includeReactions?: boolean;
    includeMutations?: boolean;
    includeReceipts?: boolean;
    sendOwnerReadReceipt?: (room: string, event: string) => Promise<void>;
    profilePicture?: (identity: string) => Promise<Uint8Array | null>;
    protocolAvatar?: string;
    joinOwnerRoom?: (room: string) => Promise<void>;
    outbox?: OutboxStore;
    profile: string;
    owner: string;
    domain: string;
    namespace?: string;
    store: PortalStore;
    bot: BridgeIntent;
    getIntent: (mxid: string) => BridgeIntent;
    getOwnerIntent?: () => Promise<EncryptedIntent>;
    /** Read the durable latest snapshot, including an already-acknowledged snapshot on restart. */
    metadata: () => ProfileMetadata | undefined;
    assertPortalAlias?: (alias: string) => void;
    renderMedia?: (message: NormalizedNodeMessage) => Promise<Record<string, unknown>>;
    renderOwnerMedia?: (message: NormalizedNodeMessage) => Promise<Record<string, unknown>>;
    ownerReactionState?: (chat: string, message: string, emoji: string) => Promise<boolean>;
}

/** Concrete journal consumer. Unimplemented event effects throw before acknowledging a change. */
export class MatrixJournalSink implements JournalSink {
    private readonly options: Options;
    private readonly portals: PortalManager;
    private readonly ghosts: GhostManager;
    private readonly messages: MessageDelivery;
    private readonly ownerMessages: MessageDelivery;
    constructor(options: Options) {
        this.options = options;
        this.portals = new PortalManager(options.bot, options.store, options);
        this.ghosts = new GhostManager(
            options.store,
            options.profile,
            options.domain,
            options.bot,
            options.getIntent,
            options.namespace,
        );
        this.messages = new MessageDelivery(options.store, options.renderMedia);
        this.ownerMessages = new MessageDelivery(options.store, async (message) => {
            const render = options.outbox?.media.forMessage(options.profile, message.messageId)
                ? options.renderOwnerMedia
                : options.renderMedia;
            if (!render) throw new Error('Owner media renderer unavailable');
            return render(message);
        });
    }
    private async picture(chat: ConversationSummary, room: string): Promise<void> {
        if (!this.options.profilePicture) return;
        if (chat.chatId.startsWith('g:')) {
            try {
                await syncContactPicture({
                    room,
                    profile: this.options.profile,
                    chat: chat.chatId,
                    owner: this.options.owner,
                    botId: this.options.bot.userId,
                    bot: this.options.bot.underlyingClient,
                    read: this.options.profilePicture,
                });
            } catch {
                /* Retry pictures on reconciliation. */
            }
            return;
        }
        try {
            const ghostId = ghostUserId(
                this.options.profile,
                chat.chatId.slice(2),
                this.options.domain,
                this.options.namespace,
            );
            const ghost = this.options.getIntent(ghostId);
            if (ghost.userId !== ghostId) throw new Error('Picture ghost identity mismatch');
            await syncContactPicture({
                room,
                profile: this.options.profile,
                chat: chat.chatId,
                owner: this.options.owner,
                botId: this.options.bot.userId,
                ghostId,
                bot: this.options.bot.underlyingClient,
                ghost: ghost.underlyingClient,
                read: this.options.profilePicture,
            });
        } catch {
            // Pictures are best effort. Periodic metadata reconciliation retries them;
            // an unavailable or unsupported picture must never stop text delivery.
        }
    }
    private ghostMembers(members: string[], chat: string): string[] {
        return this.options.getOwnerIntent && chat.startsWith('g:')
            ? members.filter((id) => id !== this.options.profile)
            : members;
    }
    private members(metadata: ProfileMetadata, chat: ConversationSummary): string[] {
        if (chat.chatId.startsWith('c:'))
            return [...new Set([this.options.profile, chat.chatId.slice(2)])];
        const group = metadata.directory.groups.find((value) => value.groupKey === chat.chatId);
        if (!group) throw new Error('Group directory metadata is missing');
        return group.memberIdentities;
    }
    async metadata(value: ProfileMetadata, _operationId: string): Promise<void> {
        const snapshot = decodeMetadata(encodeMetadata(value));
        if (this.options.textOnly && !this.options.includeGroups)
            snapshot.chats = snapshot.chats.filter((chat) => chat.chatId.startsWith('c:'));
        // Validate topology before the first remote mutation.
        for (const chat of snapshot.chats) this.members(snapshot, chat);
        // Contact records are not proof of conversations. Only update existing portals
        // with message history; the message path creates new portals and their senders.
        const activeChats = snapshot.chats.filter(
            (chat) =>
                chat.lastMessageId && this.options.store.get(this.options.profile, chat.chatId),
        );
        const activeMembers = new Set(activeChats.flatMap((chat) => this.members(snapshot, chat)));
        for (const contact of snapshot.directory.contacts) {
            if (activeMembers.has(contact.identity))
                await this.ghosts.ensure(contact.identity, contact.displayName || contact.identity);
        }
        if (activeMembers.has(this.options.profile))
            await this.ghosts.ensure(this.options.profile, this.options.profile);
        for (const chat of activeChats) {
            const room = await this.portals.ensure(chat);
            const state = await this.options.bot.underlyingClient.getRoomState(room);
            const name = state.find(
                (event) => event.type === 'm.room.name' && event.state_key === '',
            )?.content?.name;
            if (name !== chat.name)
                await this.options.bot.underlyingClient.sendStateEvent(room, 'm.room.name', '', {
                    name: chat.name,
                });
            await this.ghosts.reconcile(
                room,
                chat.chatId,
                this.ghostMembers(this.members(snapshot, chat), chat.chatId),
            );
            await this.picture(chat, room);
        }
    }
    async message(value: NormalizedNodeMessage, operationId: string): Promise<void> {
        const message = decodeMessage(encodeMessage(value));
        if (this.options.textOnly) {
            if (
                (!this.options.includeGroups && !message.chatId.startsWith('c:')) ||
                (!['text', 'unsupported', 'poll'].includes(message.content.type) &&
                    !(this.options.includeMutations && message.content.type === 'deleted') &&
                    !(
                        this.options.includeMedia &&
                        ['image', 'video', 'audio', 'file'].includes(message.content.type)
                    )) ||
                (message.deletedAt && !this.options.includeMutations)
            )
                return;
            if (!this.options.includeReactions) message.reactions = [];
        }
        if (
            this.options.store.deletion(this.options.profile, message.chatId, message.messageId)
                ?.done
        )
            return;
        const deleted = message.content.type === 'deleted';
        // Never acknowledge effects which this assembly cannot yet reproduce on Matrix.
        if (
            !deleted &&
            (message.deletedAt ||
                (!['text', 'unsupported', 'poll'].includes(message.content.type) &&
                    message.content.type !== 'unsupported' &&
                    message.content.type !== 'poll' &&
                    !(
                        this.options.renderMedia &&
                        ['image', 'video', 'audio', 'file'].includes(message.content.type)
                    )))
        )
            throw new Error('Message requires an unimplemented delivery handler');
        if (message.direction === 'outbound' && message.senderIdentity !== this.options.profile)
            throw new Error('Outbound message has another profile identity');
        const saved = this.options.metadata();
        if (!saved) throw new Error('Message delivery requires durable metadata');
        const snapshot = decodeMetadata(encodeMetadata(saved));
        const chat = snapshot.chats.find((value) => value.chatId === message.chatId);
        if (!chat) throw new Error('Message conversation is absent from metadata');
        if (
            message.direction === 'outbound' &&
            this.options.outbox?.media.observeReply(
                this.options.profile,
                message.chatId,
                message.messageId,
                hasOutboundDeliveryEvidence(message),
            )
        )
            return;
        const echo = this.options.outbox
            ? reconcileOutboundEcho(
                  this.options.outbox,
                  this.options.store,
                  this.options.profile,
                  this.options.owner,
                  message,
                  this.options.getOwnerIntent !== undefined,
                  this.options.getOwnerIntent !== undefined &&
                      this.options.renderOwnerMedia !== undefined,
              )
            : false;
        // Reconcile owner echoes before skipping an existing root, including crash recovery.
        if (
            this.options.textOnly &&
            !this.options.includeMutations &&
            !this.options.includeReactions &&
            !this.options.includeReceipts &&
            this.options.store.messageMapping(
                this.options.profile,
                message.chatId,
                message.messageId,
            )
        )
            return;
        if (deleted) {
            const room = await this.portals.ensure(chat);
            await new DeletionDelivery(this.options.store).apply(
                this.options.profile,
                message.chatId,
                message.messageId,
                room,
                new RedactionSender(this.options.store, this.options.bot),
            );
            return;
        }
        const members = this.members(snapshot, chat);
        if (!members.includes(message.senderIdentity))
            throw new Error(
                'Historical sender is not a current member; history delivery handler required',
            );
        if (message.reactions.some((reaction) => !members.includes(reaction.senderIdentity)))
            throw new Error('Historical reaction sender requires a history delivery handler');
        const room = await this.portals.ensure(chat);
        await this.options.joinOwnerRoom?.(room);
        for (const identity of members) {
            const contact = snapshot.directory.contacts.find(
                (value) => value.identity === identity,
            );
            await this.ghosts.ensure(identity, contact?.displayName || identity);
        }
        await this.ghosts.reconcile(room, chat.chatId, this.ghostMembers(members, chat.chatId));
        await this.picture(chat, room);
        const expected = ghostUserId(
            this.options.profile,
            message.senderIdentity,
            this.options.domain,
            this.options.namespace,
        );
        const mapping = this.options.store.messageMapping(
            this.options.profile,
            message.chatId,
            message.messageId,
        );
        const priorSender = mapping?.sender ?? this.options.store.projection(operationId)?.sender;
        const ownerProjection =
            !echo &&
            (priorSender === undefined || priorSender === this.options.owner) &&
            message.direction === 'outbound' &&
            this.options.getOwnerIntent !== undefined;
        const senderId = ownerProjection ? this.options.owner : expected;
        const authorizeOwner = async () => {
            if (ownerProjection)
                await new DispatchGuard({
                    profile: this.options.profile,
                    owner: this.options.owner,
                    portals: this.options.store,
                    bot: this.options.bot,
                }).check({
                    profile: this.options.profile,
                    sender: this.options.owner,
                    roomId: room,
                    chatId: message.chatId,
                });
        };
        await authorizeOwner();

        const intent = ownerProjection
            ? await this.options.getOwnerIntent!()
            : this.options.getIntent(expected);
        if (intent.userId !== senderId) throw new Error('Message sender intent mismatch');
        await authorizeOwner();
        const sender = new EncryptedSender(intent, this.options.store);
        if (!echo && (!this.options.textOnly || this.options.includeMutations || !mapping))
            await (ownerProjection ? this.ownerMessages : this.messages).deliver(
                this.options.profile,
                room,
                senderId,
                sender,
                message,
                operationId,
            );
        if (!this.options.textOnly || this.options.includeReactions)
            await new ReactionDelivery(
                this.options.store,
                this.options.outbox?.reactions,
                this.options.ownerReactionState,
            ).reconcile(
                this.options.profile,
                message,
                operationId,
                async (identity) => {
                    if (identity === this.options.profile && this.options.getOwnerIntent)
                        return new EncryptedSender(
                            await this.options.getOwnerIntent(),
                            this.options.store,
                        );
                    const mxid = ghostUserId(
                        this.options.profile,
                        identity,
                        this.options.domain,
                        this.options.namespace,
                    );
                    const reactionIntent = this.options.getIntent(mxid);
                    if (reactionIntent.userId !== mxid)
                        throw new Error('Reaction sender intent mismatch');
                    return new EncryptedSender(reactionIntent, this.options.store);
                },
                new RedactionSender(this.options.store, this.options.bot),
            );
        if (!this.options.textOnly || this.options.includeReceipts)
            await new StatusDelivery(this.options.store).apply(
                this.options.profile,
                message,
                operationId,
                new EncryptedSender(this.options.bot, this.options.store),
                async (identity) => {
                    if (!members.includes(identity))
                        throw new Error('Receipt reader is not a current member');
                    if (identity === this.options.profile && this.options.sendOwnerReadReceipt)
                        return {sendReadReceipt: this.options.sendOwnerReadReceipt};
                    const mxid = ghostUserId(
                        this.options.profile,
                        identity,
                        this.options.domain,
                        this.options.namespace,
                    );
                    const reader = this.options.getIntent(mxid);
                    if (reader.userId !== mxid) throw new Error('Receipt intent identity mismatch');
                    await reader.enableEncryption();
                    return reader.underlyingClient;
                },
            );
    }
}
