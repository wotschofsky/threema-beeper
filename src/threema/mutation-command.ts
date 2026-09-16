import type {NodeMutationRequest} from '../../integrations/threema/overlay/src/headless/node-mutation-types.ts';
export type {NodeMutationRequest};

/** Scalar-only ownership target; eligibility is checked again against the live native model. */
export function parseMutationCommand(value: unknown): NodeMutationRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid mutation request');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some(
            (key) =>
                ![
                    'profile',
                    'chatId',
                    'messageId',
                    'action',
                    ...(row.action === 'edit' ? ['text'] : []),
                ].includes(key),
        ) ||
        typeof row.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(row.profile) ||
        typeof row.chatId !== 'string' ||
        !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(row.chatId) ||
        typeof row.messageId !== 'string' ||
        !/^m:[0-9a-f]{16}$/.test(row.messageId) ||
        (row.action !== 'edit' && row.action !== 'delete') ||
        (row.action === 'edit' &&
            (typeof row.text !== 'string' || Buffer.byteLength(row.text) > 6000))
    )
        throw new Error('Invalid mutation request');
    const target = {profile: row.profile, chatId: row.chatId, messageId: row.messageId};
    return row.action === 'edit'
        ? {...target, action: 'edit', text: row.text as string}
        : {...target, action: 'delete'};
}
