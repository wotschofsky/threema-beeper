import {existsSync, lstatSync, mkdirSync, rmSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {BackendController} from '../threema/backend-controller.ts';
import {generateProfileSecret, saveProfileSecret} from './profile-secret.ts';
import {linkingEmojis} from './link-emojis.ts';
import type {SetupAuditEvent} from './audit.ts';

export type SetupState =
    | {state: 'idle' | 'preparing' | 'syncing' | 'finished' | 'cancelled' | 'interrupted'}
    | {state: 'ready'; identity: string}
    | {state: 'qr'; uri: string}
    | {state: 'confirm'; emojis: string[]}
    | {state: 'error'; code: string};
export interface SetupBackend {
    readonly ready: Promise<void>;
    link(): Promise<void>;
    identity(): Promise<string>;
    providePassword(password: string): Promise<void>;
    stop(): Promise<void>;
}
interface Options {
    profileDirectory: string;
    secretFile: string;
    wasmFile: string;
    expectedIdentity?: string;
    onAudit?: (event: SetupAuditEvent) => void;
    backendFactory?: (options: ConstructorParameters<typeof BackendController>[0]) => SetupBackend;
}

/** Local setup coordinator. It can create only a new profile, never take over an existing one. */
export class LinkSession {
    private readonly options: Options;
    private backend?: SetupBackend;
    private current: SetupState = {state: 'idle'};
    private ownedProfile?: {dev: number; ino: number};
    private secret?: string;
    private secretSaved = false;
    private stateQueue: Promise<void> = Promise.resolve();
    private operation?: Promise<void>;
    private terminal = false;

    constructor(options: Options) {
        if (
            !isAbsolute(options.profileDirectory) ||
            !isAbsolute(options.secretFile) ||
            !isAbsolute(options.wasmFile)
        )
            throw new Error('Setup paths must be absolute');
        if (
            options.expectedIdentity !== undefined &&
            !/^[A-Z0-9*][A-Z0-9]{7}$/.test(options.expectedIdentity)
        )
            throw new Error('Invalid expected setup identity');
        this.options = options;
    }
    private audit(event: SetupAuditEvent): void {
        // An observer failure must not interrupt secret persistence or profile cleanup.
        try {
            this.options.onAudit?.(event);
        } catch {
            /* Observer is best-effort. */
        }
    }
    get state(): SetupState {
        return structuredClone(this.current);
    }

    begin(): Promise<void> {
        if (this.current.state !== 'idle')
            return Promise.reject(new Error('Setup has already started'));
        this.current = {state: 'preparing'};
        this.audit('link-started');
        this.operation = this.run();
        return this.operation;
    }

    recoverySecret(): string {
        if (this.current.state !== 'ready' || !this.secret)
            throw new Error('Recovery secret is not available');
        return this.secret;
    }
    finish(recoverySaved: boolean): void {
        if (this.current.state !== 'ready' || !recoverySaved)
            throw new Error('Confirm saving the recovery secret before finishing');
        this.secret = undefined;
        this.current = {state: 'finished'};
        this.audit('recovery-acknowledged');
    }

    async cancel(): Promise<void> {
        if (
            this.secretSaved ||
            this.current.state === 'ready' ||
            this.current.state === 'finished'
        ) {
            throw new Error(
                'Synchronization may have registered the device; stop without deleting the profile',
            );
        }
        this.terminal = true;
        this.current = {state: 'cancelled'};
        await this.backend?.stop();
        await this.operation?.catch(() => undefined);
        this.removeOwnedIncompleteProfile();
        this.audit('link-cancelled');
    }

    /** Stop after synchronization began without risking deletion of a registered identity. */
    async stop(): Promise<void> {
        this.terminal = true;
        await this.backend?.stop();
        await this.operation?.catch(() => undefined);
        if (
            this.current.state !== 'ready' &&
            this.current.state !== 'finished' &&
            this.current.state !== 'interrupted' &&
            this.current.state !== 'cancelled'
        ) {
            this.current = {state: 'interrupted'};
            this.audit('link-interrupted');
        }
    }

    private async run(): Promise<void> {
        try {
            if (existsSync(this.options.profileDirectory) || existsSync(this.options.secretFile))
                throw new Error('Existing setup data');
            mkdirSync(this.options.profileDirectory, {mode: 0o700});
            const info = lstatSync(this.options.profileDirectory);
            this.ownedProfile = {dev: info.dev, ino: info.ino};
            const factory =
                this.options.backendFactory ?? ((options) => new BackendController(options));
            this.backend = factory({
                profileDirectory: this.options.profileDirectory,
                wasmFile: this.options.wasmFile,
                onState: (type, state) => {
                    if (type !== 'link-state' || this.terminal) return;
                    this.stateQueue = this.stateQueue.then(async () => {
                        await this.handleState(state);
                    });
                    // Handle failure promptly even while link() is waiting for a password.
                    void this.stateQueue.catch(() => {
                        void this.backend?.stop();
                    });
                },
            });
            await this.backend.ready;
            if (this.terminal) return;
            await this.backend.link();
            await this.stateQueue;
            if (this.terminal) return;
            if (!this.secretSaved)
                throw new Error('Link completed without a persisted profile secret');
            const identity = await this.backend.identity();
            if (
                this.options.expectedIdentity !== undefined &&
                identity !== this.options.expectedIdentity
            )
                throw new Error('Linked identity differs from configured identity');
            if (this.terminal) return;
            this.current = {state: 'ready', identity};
            this.audit('link-ready');
        } catch {
            if (!this.terminal) {
                this.current = {state: 'error', code: 'link-failed'};
                this.audit('link-failed');
            }
            await this.backend?.stop();
            if (!this.secretSaved) this.removeOwnedIncompleteProfile();
            throw new Error('Local setup failed');
        }
    }
    private async handleState(value: unknown): Promise<void> {
        if (this.terminal) return;
        if (!value || typeof value !== 'object' || !('state' in value))
            throw new Error('Invalid linking state');
        const state = value as Record<string, unknown>;
        switch (state.state) {
            case 'initializing':
                this.current = {state: 'preparing'};
                break;
            case 'waiting-for-handshake':
                if (
                    typeof state.joinUri !== 'string' ||
                    !state.joinUri.startsWith('threema://device-group/join#')
                )
                    throw new Error('Invalid join URI');
                this.current = {state: 'qr', uri: state.joinUri};
                break;
            case 'nominated':
                if (!(state.rph instanceof Uint8Array)) throw new Error('Invalid path hash');
                this.current = {state: 'confirm', emojis: linkingEmojis(state.rph)};
                break;
            case 'waiting-for-password':
                if (this.secretSaved) throw new Error('Profile secret already supplied');
                this.secret = generateProfileSecret();
                saveProfileSecret(this.options.secretFile, this.secret);
                this.secretSaved = true;
                this.audit('profile-secret-persisted');
                this.current = {state: 'syncing'};
                await this.backend!.providePassword(this.secret);
                break;
            case 'syncing':
            case 'registered':
                this.current = {state: 'syncing'};
                break;
            case 'error':
                throw new Error('Backend linking failed');
            default:
                throw new Error('Unsupported linking state');
        }
    }
    private removeOwnedIncompleteProfile(): void {
        if (!this.ownedProfile || this.secretSaved) return;
        const info = lstatSync(this.options.profileDirectory);
        if (
            info.isSymbolicLink() ||
            info.dev !== this.ownedProfile.dev ||
            info.ino !== this.ownedProfile.ino
        )
            throw new Error('Setup profile ownership changed');
        rmSync(this.options.profileDirectory, {recursive: true});
        this.ownedProfile = undefined;
        this.audit('incomplete-profile-removed');
    }
}
