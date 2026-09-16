import type {ServiceConfig} from '../service/config.ts';

/** Routing identity, retained only inside the encrypted archive/private restore workspace. */
export function backupProfileBinding(config: ServiceConfig) {
    return {
        profileId: config.profileId,
        threemaIdentity: config.identity,
        matrixOwner: config.owner,
        matrixDomain: config.matrix.domain,
        matrixNamespace: config.matrix.namespace,
        matrixHomeserver: config.matrix.homeserver,
    };
}
