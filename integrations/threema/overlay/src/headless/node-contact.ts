import type {BackendHandle} from '~/common/dom/backend';
import {ensureIdentityString} from '~/common/network/types';
import type {RemoteProxy} from '~/common/utils/endpoint';
import {readNodeDirectory} from './node-directory';

class ContactLookupRejection extends Error {
    readonly type: 'contact-unavailable' | 'contact-is-self';
    constructor(type: ContactLookupRejection['type']) {
        super(type);
        this.type = type;
    }
}

/** Follow Desktop's directory lookup and receiver-list promotion path; no keys leave the worker. */
export async function ensureNodeContact(handle: RemoteProxy<BackendHandle>, input: unknown) {
    // Validate ASCII before uppercasing so Unicode expansion cannot form a valid ID.
    if (typeof input !== 'string' || !/^[A-Za-z0-9*][A-Za-z0-9]{7}$/.test(input)) {
        throw new Error('Invalid contact identity');
    }
    const identity = ensureIdentityString(input.toUpperCase());
    const {viewModelController: controller} = await handle.viewModel.receiverList();
    const results = await controller.lookupContact(new Set([identity]));
    if (results.length !== 1) throw new Error('Invalid contact lookup result');
    const result = results[0]!;
    switch (result.type) {
        case 'invalid': throw new ContactLookupRejection('contact-unavailable');
        case 'me': throw new ContactLookupRejection('contact-is-self');
        case 'new':
            await controller.createContact(result.contactInit);
            break;
        case 'exists-in-group': {
            const contact = await handle.model.contacts.getByUid(result.uid);
            if (contact === undefined) throw new Error('Contact disappeared during lookup');
            const {firstName, lastName} = contact.get().view;
            await controller.updateAcquaintanceLevelAndName(result.uid, {firstName, lastName});
            break;
        }
        case 'exists-direct': break;
    }
    // Also re-read after a synced-device creation race, using authoritative public metadata.
    const contact = (await readNodeDirectory(handle)).contacts.find(row => row.identity === identity);
    if (contact === undefined) throw new Error('Contact creation has not completed');
    return contact;
}
