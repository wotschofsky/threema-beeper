import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import type {EncryptedIntent} from './encrypted-sender.ts';

/** Standard double-puppet path: bot crypto, owner appservice event transport. */
export async function createOwnerBridgeIntent(options: {
    owner: string;
    bot: EncryptedIntent;
    ownerClient: Pick<MatrixClient, 'getWhoAmI' | 'doRequest'>;
    authorize(room: string): Promise<void>;
    assertOpen(): void;
}): Promise<EncryptedIntent> {
    options.assertOpen();
    const identity = await options.ownerClient.getWhoAmI();
    if (identity.user_id !== options.owner) throw new Error('Owner transport identity mismatch');
    options.assertOpen();
    return {
        userId: options.owner,
        enableEncryption: async () => {
            options.assertOpen();
            await options.bot.enableEncryption();
            options.assertOpen();
        },
        underlyingClient: {
            get crypto() {
                options.assertOpen();
                return options.bot.underlyingClient.crypto;
            },
            getRoomStateEventContent: async (room, type, stateKey) => {
                options.assertOpen();
                await options.authorize(room);
                return options.bot.underlyingClient.getRoomStateEventContent(room, type, stateKey);
            },
            doRequest: async (method, endpoint, query, body) => {
                options.assertOpen();
                const match =
                    /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.encrypted\/[A-Za-z0-9_-]{1,200}$/.exec(
                        endpoint,
                    );
                if (
                    method !== 'PUT' ||
                    !match ||
                    query != null ||
                    body?.algorithm !== 'm.megolm.v1.aes-sha2'
                )
                    throw new Error('Owner transport permits only encrypted portal messages');
                await options.authorize(decodeURIComponent(match[1]));
                options.assertOpen();
                return options.ownerClient.doRequest(method, endpoint, null, body);
            },
        },
    };
}
