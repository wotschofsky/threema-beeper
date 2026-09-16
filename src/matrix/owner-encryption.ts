import {randomUUID} from 'node:crypto';
import type {ProtectedAppserviceStorage} from './appservice-storage.ts';

/** Establish only the configured real user, using a dedicated bridge-owned crypto device. */
export async function prepareOwnerEncryption(options: {
    owner: string;
    storage: ProtectedAppserviceStorage;
    recoverSession?: (device: string) => Promise<void>;
    intent: {
        userId: string;
        underlyingClient: {getWhoAmI(): Promise<{user_id: string; device_id?: string}>};
        enableEncryption(deviceId: string): Promise<void>;
    };
}): Promise<void> {
    const {owner, intent, storage} = options;
    if (!/^@[^\s:]+:[^\s]+$/.test(owner) || intent.userId !== owner)
        throw new Error('Invalid owner Matrix identity');
    // This must run on the configured AS client before marking the real user registered.
    const identity = await intent.underlyingClient.getWhoAmI();
    if (identity.user_id !== owner) throw new Error('Owner Matrix identity could not be verified');
    const client = storage.storageForUser(owner);
    const crypto = storage.cryptoForUser(owner);
    const stored = (await client.readValue('ownerBridgeDevice')) ?? undefined;
    const existing = await crypto.getDeviceId();
    if (stored !== undefined && !/^THREEMA_[0-9a-f-]{36}$/.test(stored))
        throw new Error('Invalid owner bridge device');
    if (existing && existing !== stored) throw new Error('Owner crypto device is not bridge-owned');
    // Persist before the first server request so an interrupted setup reuses the same device.
    const device = stored ?? `THREEMA_${randomUUID()}`;
    if (!stored) await client.storeValue('ownerBridgeDevice', device);
    await options.recoverSession?.(device);
    storage.addRegisteredUser(owner); // The identity exists; never invoke user registration.
    await intent.enableEncryption(device);
    const ready = await intent.underlyingClient.getWhoAmI();
    if (ready.user_id !== owner || ready.device_id !== device)
        throw new Error('Owner encrypted Matrix identity could not be verified');
}
