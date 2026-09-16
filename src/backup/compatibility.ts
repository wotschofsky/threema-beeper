import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

/** Upstream source compatibility only; not a release attestation or schema migration policy. */
export async function backupCompatibility() {
    const bytes = await readFile(new URL('../../docs/SOURCE-PINS.json', import.meta.url));
    assert(bytes.length <= 1024 * 1024);
    const pins = JSON.parse(bytes.toString('utf8'));
    assert(pins.schemaVersion === 1 && Array.isArray(pins.repositories));
    const repositories = pins.repositories
        .map((pin: {name: string; url: string; commit: string}) => {
            assert(
                typeof pin.name === 'string' &&
                    typeof pin.url === 'string' &&
                    /^[0-9a-f]{40}$/.test(pin.commit),
            );
            return {name: pin.name, url: pin.url, commit: pin.commit};
        })
        .sort((a: {name: string}, b: {name: string}) => a.name.localeCompare(b.name, 'en'));
    assert(
        repositories.length > 0 &&
            new Set(repositories.map((pin: {name: string}) => pin.name)).size ===
                repositories.length,
    );
    return {policy: 'exact-upstream-commits-v1', repositories};
}
