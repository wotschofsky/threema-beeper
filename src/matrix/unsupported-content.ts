import type {NormalizedNodeMessage} from '../threema/history.ts';

/** Fixed wording: unsupported payloads must never disappear or be presented as usable controls. */
export function unsupportedContent(
    message: NormalizedNodeMessage,
): Record<string, unknown> | undefined {
    if (message.content.type === 'poll')
        return {
            msgtype: 'm.notice',
            body: 'Polls are not supported in Beeper. Open Threema on your phone to view this poll and vote.',
        };
    if (message.content.type === 'unsupported')
        return {
            msgtype: 'm.notice',
            body: 'This message type is not supported in Beeper. Open Threema on your phone to view it.',
        };
    return undefined;
}
