import {randomBytes} from 'node:crypto';

import type {ReadonlyUint8Array} from '@threema/ts-utils/array/readonly-uint8-array';

import type {StoredFileHandle} from '~/common/file-storage';
import type {FileSystemFileStorage} from '~/common/node/file-storage/system-file-storage';

/** Worker-local handles. Outer IPC may carry tokens, never the registry's values. */
export class NodePreparedFiles {
    private readonly entries = new Map<
        string,
        {chat: string; handle: StoredFileHandle; state: 'prepared' | 'claimed' | 'discarding'}
    >();
    private readonly discarding = new Set<Promise<boolean>>();
    private readonly active = new Set<Promise<string>>();
    private bytes = 0;
    private count = 0;
    private closed = false;
    private closing?: Promise<void>;
    public constructor(
        private readonly storage: Pick<FileSystemFileStorage, 'storeStream' | 'delete'>,
        private readonly maximumBytes: number,
    ) {
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 ** 3) {
            throw new Error('Invalid prepared file capacity');
        }
    }
    public async prepare(
        chat: string,
        source: AsyncIterable<ReadonlyUint8Array>,
        bytes: number,
        signal?: AbortSignal,
    ): Promise<string> {
        if (
            this.closed ||
            !/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/u.test(chat) ||
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            this.bytes + bytes > this.maximumBytes ||
            this.count >= 16
        ) {
            throw new Error('Prepared file unavailable or capacity exceeded');
        }
        signal?.throwIfAborted();
        this.bytes += bytes;
        this.count++;
        const task = this.store(chat, source, bytes, signal);
        this.active.add(task);
        try {
            return await task;
        } finally {
            this.active.delete(task);
        }
    }
    private async store(
        chat: string,
        source: AsyncIterable<ReadonlyUint8Array>,
        bytes: number,
        signal?: AbortSignal,
    ): Promise<string> {
        let handle: StoredFileHandle | undefined;
        try {
            handle = await this.storage.storeStream(source, bytes, signal);
            if (this.closed) throw new Error('Prepared file registry closed');
            signal?.throwIfAborted();
            const token = randomBytes(32).toString('hex');
            if (this.entries.has(token)) throw new Error('Prepared file token collision');
            this.entries.set(token, {chat, handle, state: 'prepared'});
            return token;
        } catch (error) {
            this.bytes -= bytes;
            this.count--;
            if (handle) await this.storage.delete(handle.fileId);
            throw error;
        }
    }
    /** Irreversible claim precedes the send attempt. Claimed files must survive uncertain outcomes. */
    public claim(token: string, chat: string): StoredFileHandle {
        return this.claimMany([token], chat)[0]!;
    }
    /** Validate the complete image/thumbnail bundle before consuming any token. No await boundary. */
    public claimMany(tokens: readonly string[], chat: string): readonly StoredFileHandle[] {
        if (
            this.closed ||
            tokens.length < 1 ||
            tokens.length > 16 ||
            new Set(tokens).size !== tokens.length
        )
            throw new Error('Invalid prepared file bundle');
        const entries = tokens.map((token) => {
            const entry = this.entries.get(token);
            if (!entry || entry.chat !== chat || entry.state !== 'prepared')
                throw new Error('Prepared file is unavailable');
            return entry;
        });
        for (const entry of entries) entry.state = 'claimed';
        return entries.map((entry) => entry.handle);
    }
    /** Once the message model owns the file, forget only the temporary registry reference. */
    public transferred(token: string): void {
        this.transferredMany([token]);
    }
    public transferredMany(tokens: readonly string[]): void {
        if (tokens.length < 1 || tokens.length > 16 || new Set(tokens).size !== tokens.length)
            throw new Error('Invalid prepared file bundle');
        const entries = tokens.map((token) => {
            const entry = this.entries.get(token);
            if (entry?.state !== 'claimed') throw new Error('Prepared file was not claimed');
            return {token, entry};
        });
        for (const {token, entry} of entries) {
            this.entries.delete(token);
            this.bytes -= entry.handle.unencryptedByteCount;
            this.count--;
        }
    }
    public async discard(token: string, chat: string): Promise<boolean> {
        if (this.closed) throw new Error('Prepared file registry closed');
        const entry = this.entries.get(token);
        if (!entry) return false;
        if (entry.chat !== chat || entry.state !== 'prepared')
            throw new Error('Prepared file cannot be discarded');
        entry.state = 'discarding';
        const task = (async () => {
            try {
                await this.storage.delete(entry.handle.fileId);
                this.entries.delete(token);
                this.bytes -= entry.handle.unencryptedByteCount;
                this.count--;
                return true;
            } catch (error) {
                entry.state = 'prepared';
                throw error;
            }
        })();
        this.discarding.add(task);
        try {
            return await task;
        } finally {
            this.discarding.delete(task);
        }
    }
    public close(): Promise<void> {
        this.closed = true;
        this.closing ??= this.cleanup().finally(() => {
            this.closing = undefined;
        });
        return this.closing;
    }
    private async cleanup(): Promise<void> {
        await Promise.allSettled([...this.active, ...this.discarding]);
        let failed = false;
        for (const [token, entry] of this.entries) {
            if (entry.state === 'claimed') continue;
            try {
                await this.storage.delete(entry.handle.fileId);
                this.entries.delete(token);
                this.bytes -= entry.handle.unencryptedByteCount;
                this.count--;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Prepared file cleanup incomplete');
    }
}
