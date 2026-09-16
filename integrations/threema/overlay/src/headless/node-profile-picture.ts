import {nodeChatId} from './node-conversations';
import type {BackendHandle} from '~/common/dom/backend';
import {ensureIdentityString} from '~/common/network/types';
import type {RemoteProxy} from '~/common/utils/endpoint';

/** Read only an existing contact's picture. Never look up/add contacts or mutate its model. */
export async function readNodeProfilePicture(
    handle: RemoteProxy<BackendHandle>,
    input: string,
): Promise<Uint8Array | null> {
    if (/^g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16}$/.test(input)) {
        const ownIdentity = await handle.model.user.identity;
        const groups = await handle.model.groups.getAll();
        for (const store of groups.get()) {
            const group = store.get();
            if (nodeChatId(group, ownIdentity) !== input) continue;
            const pictureStore = await group.controller.profilePicture;
            const picture = pictureStore.get().view.picture;
            if (picture === undefined) return null;
            if (picture.byteLength === 0 || picture.byteLength > 2 * 1024 * 1024)
                throw new Error('Group picture exceeds limits');
            return new Uint8Array(picture);
        }
        return null;
    }
    if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(input)) throw new Error('Invalid contact identity');
    const contact = await handle.model.contacts.getByIdentity(ensureIdentityString(input));
    if (contact === undefined) return null;
    const pictureStore = await contact.get().controller.profilePicture;
    const picture = pictureStore.get().view.picture;
    if (picture === undefined) return null;
    if (picture.byteLength === 0 || picture.byteLength > 2 * 1024 * 1024)
        throw new Error('Contact picture exceeds limits');
    return new Uint8Array(picture);
}
