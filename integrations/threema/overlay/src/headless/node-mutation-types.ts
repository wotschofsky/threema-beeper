export type NodeMutationRequest = {
    readonly profile: string;
    readonly chatId: string;
    readonly messageId: string;
} & ({readonly action: 'edit'; readonly text: string} | {readonly action: 'delete'});
