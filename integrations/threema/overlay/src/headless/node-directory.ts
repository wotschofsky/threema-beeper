import {u64ToHexLe} from '@threema/ts-utils/number/u64-to-hex-le';

import type {BackendHandle} from '~/common/dom/backend';
import {GroupUserState} from '~/common/enum';
import type {RemoteProxy} from '~/common/utils/endpoint';

import type {DirectorySnapshot} from './node-directory-types';

/** Normalize public metadata only; keys and model controllers remain inside the backend worker. */
export async function readNodeDirectory(
    handle: RemoteProxy<BackendHandle>,
): Promise<DirectorySnapshot> {
    const ownIdentity = await handle.model.user.identity;
    const privacy = (await handle.model.user.privacySettings).get();
    const contactStores = await handle.model.contacts.getAll();
    const contacts: DirectorySnapshot['contacts'] = [];
    for (const store of contactStores.get()) {
        const view = store.get().view;
        contacts.push({
            identity: view.identity,
            firstName: view.firstName,
            lastName: view.lastName,
            displayName: view.displayName,
            verification: view.verificationLevel,
            activity: view.activityState,
            blocked: await privacy.controller.isContactBlocked(view.identity),
        });
    }
    const groupStores = await handle.model.groups.getAll();
    const groups: DirectorySnapshot['groups'] = [];
    for (const store of groupStores.get()) {
        const view = store.get().view;
        const creatorIdentity =
            view.creator === 'me' ? ownIdentity : view.creator.get().view.identity;
        const members = new Set([...view.members].map((member) => member.get().view.identity));
        if (creatorIdentity !== ownIdentity) {
            members.add(creatorIdentity);
        }
        if (view.userState === GroupUserState.MEMBER) {
            members.add(ownIdentity);
        }
        groups.push({
            groupKey: `g:${creatorIdentity}:${u64ToHexLe(view.groupId)}`,
            creatorIdentity,
            groupId: view.groupId,
            name: view.name,
            memberIdentities: [...members].sort(),
            userState: view.userState,
        });
    }
    contacts.sort((a, b) => a.identity.localeCompare(b.identity, 'en'));
    groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey, 'en'));
    return {contacts, groups};
}
