# Native crypto SDK overlay

These modified TypeScript files derive from `@vector-im/matrix-bot-sdk` 0.10.0-element.0. The
original MIT license is preserved in `LICENSE`. `source.json` records SHA-256 hashes of the original
files; the dependency tarball and its integrity are pinned in `../pnpm-lock.yaml`.

From the project root, `pnpm run prepare:matrix-native` checks the installed package and source
fingerprints, copies the overlay, and recompiles the SDK with TypeScript. Reinstalling dependencies
removes the overlay; reapply it before running `pnpm run probe:matrix-sdk`.

Changes:

- Await device metadata persistence.
- Require a provider-supplied native-store passphrase of at least 32 characters; no empty fallback.
- Close the machine on initial key-upload failure and expose explicit shutdown after work drains.
- Permit a custom metadata provider to disable the default plaintext JSON file.

`../../../src/matrix/protected-storage.ts` supplies SQLCipher metadata and separate HKDF-derived metadata and
native-store keys from a 32-byte random master key. The adapter refuses silent device changes. It is
feasibility code, not the final bridge datastore or migration implementation.

The probe uses the actual SDK send path and Rust crypto with an intercepted synthetic transport. It
proves encrypted event generation, decryption after restart, stable device identity, protected room
metadata, wrong-key rejection and refusal of an empty store passphrase. It does not establish
application-service transaction delivery, sharing keys with another device, or Beeper compatibility.

The appservice Intent overlay also fixes persistence of the returned user access token, includes a
stable device ID in login, validates the returned identity, and refuses replacement login after a
failed stored-session check. A failed crypto setup can be retried on the same intent. Native close
is idempotent and failed initial key upload releases the machine.

The RustEngine overlay now fails encryption when any required membership lookup fails, or when no
eligible recipients exist. Upstream caught lookup errors and could continue with a partial recipient
list (or reuse an existing session). The overlay preserves native recipient selection/session
rotation and changes only failure handling. The original source fingerprint is recorded in
`source.json`; preparation compiles the patched SDK.

The two-device probe now additionally verifies membership lookup failure sends no room event,
removal rotates the Megolm session, and rejoining restores decryption without access to messages
sent while absent under `joined` history visibility. All keys and encryption are native; membership
responses and the homeserver remain synthetic. This supplements the earlier single-device probe.

The HTTP overlay (`http.ts`) now recognizes Node Readable request bodies and forwards them to undici
with the supplied content type. Trace logging prints a stream marker instead of serializing stream
internals. This enables bounded ciphertext uploads without the Buffer-only uploadContent helper.
The source fingerprint is pinned. `test:encrypted-attachment` verifies the actual SDK HTTP boundary
receives a Readable and that the native attachment decryptor accepts the streamed ciphertext.
