import {createHash, hkdfSync} from 'node:crypto';
import {join} from 'node:path';
import type {
    IAppserviceStorageProvider,
    IStorageProvider,
    IFilterInfo,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProtectedCryptoStorage} from './protected-storage.ts';

class ClientStorage implements IStorageProvider {
    private readonly crypto: ProtectedCryptoStorage;
    constructor(crypto: ProtectedCryptoStorage) {
        this.crypto = crypto;
    }
    setSyncToken(token: string | null): void {
        this.storeValue('syncToken', JSON.stringify(token));
    }
    getSyncToken(): string | null {
        return JSON.parse(this.readValue('syncToken') ?? 'null') as string | null;
    }
    setFilter(filter: IFilterInfo): void {
        this.storeValue('filter', JSON.stringify(filter));
    }
    getFilter(): IFilterInfo {
        return JSON.parse(this.readValue('filter') ?? 'null') as IFilterInfo;
    }
    storeValue(key: string, value: string): void {
        this.crypto.writeClientValue(key, value);
    }
    readValue(key: string): string | undefined {
        return this.crypto.readClientValue(key);
    }
}

/** Encrypted appservice session storage; every user has a separate derived encryption key. */
export class ProtectedAppserviceStorage implements IAppserviceStorageProvider {
    private closed = false;
    private readonly directory: string;
    private readonly master: Buffer;
    private readonly stores = new Map<string, ProtectedCryptoStorage>();
    private readonly clients = new Map<string, ClientStorage>();

    constructor(directory: string, master: Buffer) {
        if (master.length !== 32) throw new Error('Expected a 32-byte appservice storage key');
        this.directory = directory;
        this.master = Buffer.from(master);
    }
    private cryptoForScope(scope: string): ProtectedCryptoStorage {
        if (this.closed) throw new Error('Appservice storage is closed');
        let storage = this.stores.get(scope);
        if (!storage) {
            const name = createHash('sha256').update(scope).digest('hex');
            const key = Buffer.from(
                hkdfSync('sha256', this.master, Buffer.alloc(0), 'matrix-user:' + scope, 32),
            );
            try {
                storage = new ProtectedCryptoStorage(join(this.directory, name), key);
            } finally {
                key.fill(0);
            }
            this.stores.set(scope, storage);
        }
        return storage;
    }
    cryptoForUser(userId: string): ProtectedCryptoStorage {
        if (!/^@[^:]+:.+$/.test(userId)) throw new Error('Invalid Matrix user ID');
        return this.cryptoForScope('user:' + userId);
    }
    storageForUser(userId: string): IStorageProvider {
        let client = this.clients.get(userId);
        if (!client) {
            client = new ClientStorage(this.cryptoForUser(userId));
            this.clients.set(userId, client);
        }
        return client;
    }
    addRegisteredUser(userId: string): void {
        this.cryptoForScope('appservice').writeClientValue('registered:' + userId, '1');
    }
    isUserRegistered(userId: string): boolean {
        return this.cryptoForScope('appservice').readClientValue('registered:' + userId) === '1';
    }
    setTransactionCompleted(id: string): void {
        this.cryptoForScope('appservice').writeClientValue('transaction:' + id, '1');
    }
    isTransactionCompleted(id: string): boolean {
        return this.cryptoForScope('appservice').readClientValue('transaction:' + id) === '1';
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const storage of this.stores.values()) storage.close();
        this.stores.clear();
        this.clients.clear();
        this.master.fill(0);
    }
}
