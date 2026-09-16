import assert from 'node:assert/strict';
import {createHash, hkdfSync} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {RustSdkCryptoStorageProvider} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/storage/RustSdkCryptoStorageProvider.js';
import type {ICryptoRoomInformation} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/e2ee/ICryptoRoomInformation.js';

/** Gate 0 adapter: SQLCipher metadata and a separately derived native-store passphrase. */
export class ProtectedCryptoStorage extends RustSdkCryptoStorageProvider {
    private readonly metadata: Database.Database;
    private readonly machineSecret: Buffer;

    public constructor(directory: string, masterKey: Buffer) {
        assert.equal(masterKey.length, 32, 'A 32-byte random master key is required');
        mkdirSync(directory, {recursive: true, mode: 0o700});
        // The overlay allows custom metadata providers to avoid creating a plaintext JSON file.
        super(directory, 0, false);
        const metadataKey = Buffer.from(
            hkdfSync('sha256', masterKey, Buffer.alloc(0), 'matrix-metadata-v1', 32),
        );
        this.machineSecret = Buffer.from(
            hkdfSync('sha256', masterKey, Buffer.alloc(0), 'matrix-machine-v1', 32),
        );
        this.metadata = new Database(join(directory, 'metadata.sqlite'));
        try {
            this.metadata.pragma('cipher_compatibility = 4');
            this.metadata.pragma(`key = "x'${metadataKey.toString('hex')}'"`);
            this.metadata.pragma('cipher_log_level = NONE');
            this.metadata.pragma('journal_mode = WAL');
            this.metadata.pragma('synchronous = FULL');
            this.metadata.exec(
                'CREATE TABLE IF NOT EXISTS crypto_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
            );
        } catch (error) {
            this.metadata.close();
            this.machineSecret.fill(0);
            throw error;
        } finally {
            metadataKey.fill(0);
        }
    }

    public async getMachineStorePassphrase(): Promise<string> {
        assert.ok(this.metadata.open, 'Crypto storage is closed');
        return this.machineSecret.toString('base64');
    }

    public override async getMachineStoragePath(deviceId: string): Promise<string> {
        assert.ok(deviceId.length > 0);
        return join(this.storagePath, createHash('sha256').update(deviceId).digest('hex'));
    }

    public override async getDeviceId(): Promise<string> {
        return this.read('device') ?? '';
    }

    public override async setDeviceId(deviceId: string): Promise<void> {
        const existing = await this.getDeviceId();
        assert.ok(
            !existing || existing === deviceId,
            'Device identity changed; explicit reset required',
        );
        this.write('device', deviceId);
    }

    public override async getRoom(roomId: string): Promise<ICryptoRoomInformation> {
        const value = this.read(`room:${roomId}`);
        // The SDK documents a falsy return for unknown rooms but omits it from the return type.
        return value === undefined ? undefined! : (JSON.parse(value) as ICryptoRoomInformation);
    }

    public override async storeRoom(roomId: string, config: ICryptoRoomInformation): Promise<void> {
        this.write(`room:${roomId}`, JSON.stringify(config));
    }

    public readClientValue(key: string): string | undefined {
        return this.read('client:' + key);
    }

    public writeClientValue(key: string, value: string): void {
        this.write('client:' + key, value);
    }

    public close(): void {
        this.metadata.close();
        this.machineSecret.fill(0);
    }

    private read(key: string): string | undefined {
        const row = this.metadata
            .prepare('SELECT value FROM crypto_metadata WHERE key = ?')
            .get(key) as {value: string} | undefined;
        return row?.value;
    }

    private write(key: string, value: string): void {
        this.metadata
            .prepare(
                'INSERT INTO crypto_metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            )
            .run(key, value);
    }
}
