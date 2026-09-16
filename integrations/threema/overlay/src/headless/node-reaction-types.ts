export interface NodeReactionRequest {
    readonly profile: string;
    readonly chatId: string;
    readonly messageId: string;
    readonly emoji: string;
    readonly action: 'apply' | 'withdraw';
}
