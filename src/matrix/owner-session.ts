import type {IStorageProvider} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';

type Identity = {user_id: string; device_id?: string};

/** Renew only an explicitly rejected session for an already verified bridge-owned device. */
export async function recoverOwnerSession(options: {
    owner: string;
    device: string;
    storage: Pick<IStorageProvider, 'readValue' | 'storeValue'>;
    whoami(token: string): Promise<Identity>;
    login(device: string): Promise<Identity & {access_token: string}>;
}): Promise<void> {
    const {owner, device, storage} = options;
    if (!/^@[^\s:]+:[^\s]+$/.test(owner) || !/^THREEMA_[0-9a-f-]{36}$/.test(device))
        throw new Error('Invalid owner session recovery identity');
    const token = await storage.readValue('accessToken');
    if (!token) return; // First initialization remains the SDK's responsibility.
    const matches = (identity: Identity) =>
        identity.user_id === owner && identity.device_id === device;
    let identity: Identity;
    try {
        identity = await options.whoami(token);
    } catch (error) {
        const failure = error as {statusCode?: number; errcode?: string};
        if (failure?.statusCode !== 401 || failure.errcode !== 'M_UNKNOWN_TOKEN') throw error;
        const renewed = await options.login(device);
        if (!matches(renewed) || typeof renewed.access_token !== 'string' || !renewed.access_token)
            throw new Error('Owner session renewal returned an unexpected identity');
        if (!matches(await options.whoami(renewed.access_token)))
            throw new Error('Renewed owner session could not be verified');
        // Never write an unverified token, reset crypto, or change the requested device.
        await storage.storeValue('accessToken', renewed.access_token);
        return;
    }
    if (!matches(identity)) throw new Error('Stored owner session identity does not match');
}
