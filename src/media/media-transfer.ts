import {createHash} from 'node:crypto';
import type {Readable} from 'node:stream';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {EncryptedFile} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/models/events/MessageEvent.js';
import type {PortalStore} from '../matrix/portal-store.ts';
import {
    prepareAttachment,
    type AttachmentInput,
    type PreparedAttachment,
} from './encrypted-attachment.ts';
import {
    discardAttachment,
    MissingAttachmentSpool,
    restoreAttachment,
    type AttachmentDescriptor,
} from './restore-attachment.ts';
import {cleanupAttachmentSpools, cleanupOutboundAttachmentSpools} from './spool-cleanup.ts';
import {uploadAttachment} from './upload-attachment.ts';

/** One instance per owned profile. SQLCipher persists attachment keys before the upload begins. */
export class MediaTransfer {
    private readonly store: PortalStore;
    private readonly directory: string;
    private initialization: Promise<void> | undefined;
    private readonly pending = new Map<
        string,
        {fingerprint: string; task: Promise<EncryptedFile>}
    >();
    constructor(store: PortalStore, directory: string) {
        this.store = store;
        this.directory = directory;
    }
    /** Must own the profile and use one transfer instance for its private spool directory. */
    initialize(): Promise<void> {
        return (this.initialization ??= (async () => {
            await cleanupAttachmentSpools(this.directory, this.store.pendingMediaSpools());
            await cleanupOutboundAttachmentSpools(this.directory);
        })());
    }
    async transfer(
        id: string,
        scope: string,
        client: Pick<MatrixClient, 'doRequest'>,
        source: () => Promise<Readable>,
        input: AttachmentInput,
    ): Promise<EncryptedFile> {
        input = {...input};
        input.signal?.throwIfAborted();
        if (
            !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
            !scope ||
            scope.length > 4096 ||
            !Number.isSafeInteger(input.bytes) ||
            input.bytes < 0 ||
            !Number.isSafeInteger(input.maxBytes) ||
            input.maxBytes < 1 ||
            input.maxBytes > 1024 ** 3 ||
            !/^[0-9a-f]{64}$/.test(input.sha256) ||
            typeof input.verifyMime !== 'function' ||
            !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mimeType) ||
            input.bytes > input.maxBytes
        )
            throw new Error('Invalid media transfer');
        const fingerprint = createHash('sha256')
            .update(JSON.stringify([scope, input.bytes, input.sha256, input.mimeType]))
            .digest('hex');
        const old = this.pending.get(id);
        if (old) {
            if (old.fingerprint !== fingerprint) throw new Error('Media upload operation conflict');
            return structuredClone(await old.task);
        }
        const task = this.perform(id, fingerprint, client, source, input).finally(() =>
            this.pending.delete(id),
        );
        this.pending.set(id, {fingerprint, task});
        return structuredClone(await task);
    }
    private async perform(
        id: string,
        fingerprint: string,
        client: Pick<MatrixClient, 'doRequest'>,
        source: () => Promise<Readable>,
        input: AttachmentInput,
    ): Promise<EncryptedFile> {
        await this.initialize();
        input.signal?.throwIfAborted();
        const saved = this.store.mediaUpload(id);
        if (saved && saved.fingerprint !== fingerprint)
            throw new Error('Media upload operation conflict');
        if (saved?.result) {
            await discardAttachment(
                this.directory,
                (JSON.parse(saved.prepared) as AttachmentDescriptor).spoolId,
            );
            return JSON.parse(saved.result) as EncryptedFile;
        }
        let prepared: PreparedAttachment | undefined;
        if (saved) {
            try {
                prepared = await restoreAttachment(
                    this.directory,
                    JSON.parse(saved.prepared) as AttachmentDescriptor,
                );
            } catch (error) {
                // Missing temporary data can be reconstructed from the verified source.
                // Corruption, permissions and malformed descriptors require investigation.
                if (!(error instanceof MissingAttachmentSpool)) throw error;
            }
        }
        if (!prepared) {
            input.signal?.throwIfAborted();
            prepared = await prepareAttachment(await source(), this.directory, input);
            try {
                const descriptor = JSON.stringify({
                    spoolId: prepared.spoolId,
                    bytes: prepared.bytes,
                    file: prepared.file,
                });
                if (saved)
                    this.store.replaceMediaUpload(id, fingerprint, saved.prepared, descriptor);
                else this.store.prepareMediaUpload(id, fingerprint, descriptor);
            } catch (error) {
                await prepared.dispose();
                throw error;
            }
            if (saved)
                await discardAttachment(
                    this.directory,
                    (JSON.parse(saved.prepared) as AttachmentDescriptor).spoolId,
                );
        }
        // On upload failure retain ciphertext and keys for retry. No plaintext spool exists.
        const file = await uploadAttachment(client, prepared, input.signal);
        this.store.completeMediaUpload(id, JSON.stringify(file));
        await prepared.dispose();
        return file;
    }
}
