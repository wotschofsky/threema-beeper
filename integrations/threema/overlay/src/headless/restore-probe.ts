import {randomFillSync} from 'node:crypto';
import {createDefaultConfig} from '~/common/config';
import {TweetNaClBackend} from '~/common/crypto/tweetnacl';
import {NOOP_LOGGER} from '~/common/logging';
import {createNodeFactories} from './node-factories';
import type {ServicesForKeyStorage} from '~/common/key-storage';

/** Offline scratch-copy verification only: never create a Backend, session or transport. */
export async function verifyRestoredProfile(
    directory: string,
    password: string,
    expectedIdentity: string,
): Promise<{identityMatches: true; databaseIntegrity: true}> {
    const factories = createNodeFactories(directory);
    if (!factories.hasIdentity()) throw new Error('Restored identity is missing');
    const storage = factories.keyStorage(
        {
            crypto: new TweetNaClBackend((buffer) => {
                randomFillSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
                return buffer;
            }),
            electron: new Proxy({} as ServicesForKeyStorage['electron'], {
                get() {
                    throw new Error('Electron services are unavailable in offline verification');
                },
            }),
            logging: {logger: () => NOOP_LOGGER},
            systemInfo: {
                os: process.platform === 'darwin' ? 'macos' : 'linux',
                arch: process.arch,
                locale: 'en',
                isSafeStorageAvailable: false,
            },
        },
        NOOP_LOGGER,
    );
    const contents = await storage.init(password, async (info) => {
        // Remote-secret profiles require an online policy check and are outside this offline probe.
        if (info.isInnerRemoteSecretProtected)
            throw new Error('Remote-secret profile cannot be checked offline');
    });
    try {
        if (contents.inner.identityData.identity !== expectedIdentity)
            throw new Error('Restored identity mismatch');
        const database = factories.db(
            {config: createDefaultConfig()},
            NOOP_LOGGER,
            {userIdentity: contents.inner.identityData.identity},
            contents.inner.databaseKey,
            true,
        );
        // The factory runs migrations and checks integrity before returning.
        database.close();
        return {identityMatches: true, databaseIntegrity: true};
    } finally {
        contents.inner.identityData.ck.purge();
        contents.inner.dgk.purge();
        contents.inner.databaseKey.purge();
    }
}
