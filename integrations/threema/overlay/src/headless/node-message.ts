import {bytesToHex} from '@threema/ts-utils/byte/bytes-to-hex';
import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import {MessageDirection, MessageType} from '~/common/enum';
import type {RemoteModelFor} from '~/common/model/types/common';
import type {AnyMessageModel} from '~/common/model/types/message';

import type {NormalizedNodeMessage} from './node-message-types';

export type {NormalizedNodeMessage} from './node-message-types';

/** Explicit allowlist: no raw protocol body, media encryption keys, file paths or controllers. */
export async function normalizeNodeMessage(
    model: RemoteModelFor<AnyMessageModel>,
    chatId: string,
    ownIdentity: string,
): Promise<NormalizedNodeMessage> {
    const view = model.view;
    // Capture the view before awaiting remote sender lookup so edits cannot mix two versions.
    const senderIdentity =
        model.ctx === MessageDirection.INBOUND
            ? (await model.controller.sender()).get().view.identity
            : ownIdentity;
    const common: Omit<NormalizedNodeMessage, 'content'> = {
        messageId: `m:${u64ToHexLe(view.id)}`,
        chatId,
        direction: view.direction === MessageDirection.INBOUND ? 'inbound' : 'outbound',
        senderIdentity,
        createdAt: view.createdAt,
        receivedAt: view.direction === MessageDirection.INBOUND ? view.receivedAt : undefined,
        sentAt: view.direction === MessageDirection.OUTBOUND ? view.sentAt : undefined,
        deliveredAt: view.direction === MessageDirection.OUTBOUND ? view.deliveredAt : undefined,
        readAt: view.readAt,
        editedAt: view.lastEditedAt,
        deletedAt: view.deletedAt,
        ordinal: BigInt(view.ordinal),
        reactions: view.reactions.map((reaction) => ({
            senderIdentity: reaction.senderIdentity,
            emoji: reaction.reaction,
            reactedAt: reaction.reactionAt,
        })),
    };
    switch (model.type) {
        case MessageType.TEXT:
            return {
                ...common,
                replyToMessageId:
                    model.view.quotedMessageId === undefined
                        ? undefined
                        : `m:${u64ToHexLe(model.view.quotedMessageId)}`,
                content: {type: 'text' as const, text: model.view.text},
            };
        case MessageType.DELETED:
            return {...common, content: {type: 'deleted' as const}};
        case MessageType.FILE:
        case MessageType.IMAGE:
        case MessageType.VIDEO:
        case MessageType.AUDIO: {
            const media = model.view;
            return {
                ...common,
                content: {
                    type: model.type,
                    mimeType: media.mediaType,
                    fileName: media.fileName,
                    byteSize: media.fileSize,
                    caption: media.caption,
                    blobRef:
                        media.blobId === undefined ? undefined : `b:${bytesToHex(media.blobId)}`,
                    thumbnailRef:
                        media.thumbnailBlobId === undefined
                            ? undefined
                            : `b:${bytesToHex(media.thumbnailBlobId)}`,
                    thumbnailMimeType: media.thumbnailMediaType,
                    dimensions:
                        model.type === MessageType.IMAGE || model.type === MessageType.VIDEO
                            ? model.view.dimensions
                            : undefined,
                    durationSeconds:
                        model.type === MessageType.AUDIO || model.type === MessageType.VIDEO
                            ? model.view.duration
                            : undefined,
                },
            };
        }
        case MessageType.POLL:
            return {
                ...common,
                content: {
                    type: 'poll' as const,
                    pollId: u64ToHexLe(model.view.pollId),
                    creatorIdentity: model.view.pollCreatorIdentity,
                    description: model.view.description,
                    state: model.view.pollState,
                    answerType: model.view.answerType,
                    announceType: model.view.announceType,
                    displayMode: model.view.displayMode,
                    choicesType: model.view.choicesType,
                    messageType: model.view.pollMessageType,
                    choices: model.view.choices.map((choice) => ({
                        id: choice.choiceId,
                        description: choice.description,
                        sortKey: choice.sortKey,
                        totalVotes: choice.totalAmountVotes,
                        votes: choice.votes.map((vote) => ({
                            senderIdentity: vote.senderIdentity,
                            selected: vote.selected,
                        })),
                    })),
                },
            };
        default:
            return {
                ...common,
                content: {type: 'unsupported' as const, description: 'Unsupported Threema message'},
            };
    }
}
