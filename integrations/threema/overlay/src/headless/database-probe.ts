import {randomBytes} from 'node:crypto';

import {createDefaultConfig} from '~/common/config';
import {wrapRawDatabaseKey} from '~/common/db';
import {NOOP_LOGGER} from '~/common/logging';
import {ensureIdentityString} from '~/common/network/types';

import {createNodeFactories} from './node-factories';

/** Runs the real upstream migrations in a fresh synthetic profile and reopens the database. */
export function probeProfileDatabase(profileDirectory: string): {readonly contacts: number} {
    const factories = createNodeFactories(profileDirectory);
    const services = {config: createDefaultConfig()};
    const supplements = {userIdentity: ensureIdentityString('ABCDEFGH')};
    const secret = randomBytes(32);
    const first = factories.db(
        services,
        NOOP_LOGGER,
        supplements,
        wrapRawDatabaseKey(Uint8Array.from(secret)),
        false,
    );
    try {
        first.getAllContactUids();
    } finally {
        first.close();
    }
    const reopened = factories.db(
        services,
        NOOP_LOGGER,
        supplements,
        wrapRawDatabaseKey(Uint8Array.from(secret)),
        true,
    );
    try {
        return {contacts: reopened.getAllContactUids().length};
    } finally {
        reopened.close();
        secret.fill(0);
    }
}
