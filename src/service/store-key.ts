import {hkdfSync} from 'node:crypto';
import type {ServiceConfig} from './config.ts';

/** Stable on-disk key derivation shared by service startup and read-only diagnostics. */
export function deriveStoreKey(
    master: Buffer,
    config: Pick<ServiceConfig, 'profileId' | 'identity'>,
    purpose: 'journal' | 'inbox' | 'portals' | 'outbox' | 'matrix',
): Buffer {
    if (master.length !== 32) throw new Error('Invalid store key size');
    return Buffer.from(
        hkdfSync(
            'sha256',
            master,
            Buffer.alloc(0),
            JSON.stringify([
                'threema-beeper-stores-v1',
                config.profileId,
                config.identity,
                purpose,
            ]),
            32,
        ),
    );
}
