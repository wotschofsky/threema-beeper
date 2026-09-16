export interface NormalizedNodeMessage {
    messageId: string;
    chatId: string;
    direction: 'inbound' | 'outbound';
    senderIdentity: string;
    createdAt: Date;
    receivedAt?: Date;
    sentAt?: Date;
    deliveredAt?: Date;
    readAt?: Date;
    editedAt?: Date;
    deletedAt?: Date;
    ordinal: bigint;
    replyToMessageId?: string;
    reactions: {senderIdentity: string; emoji: string; reactedAt: Date}[];
    content:
        | {type: 'text'; text: string}
        | {type: 'deleted'}
        | {type: 'unsupported'; description: string}
        | {
              type: 'image' | 'video' | 'audio' | 'file';
              mimeType: string;
              fileName?: string;
              byteSize: number;
              caption?: string;
              blobRef?: string;
              thumbnailRef?: string;
              thumbnailMimeType?: string;
              dimensions?: {width: number; height: number};
              durationSeconds?: number;
          }
        | {
              type: 'poll';
              pollId: string;
              creatorIdentity: string;
              description: string;
              state: number;
              answerType: number;
              announceType: number;
              displayMode: number;
              choicesType: number;
              messageType: number;
              choices: {
                  id: number;
                  description: string;
                  sortKey: number;
                  totalVotes?: number;
                  votes: {senderIdentity: string; selected: boolean}[];
              }[];
          };
}
