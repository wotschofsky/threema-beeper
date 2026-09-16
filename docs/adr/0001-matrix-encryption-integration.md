# ADR 0001: Matrix encryption requires an explicit integration spike

Status: investigation; no production architecture change adopted.

## Evidence

At `matrix-appservice-bridge` commit `fe923be791bd1d2ade17839629a99400893c8173`:

- `src/bridge.ts` constructs the bot SDK Appservice without `cryptoStorage`.
- `bridgeEncryption.homeserverUrl` is the Pantalaimon proxy URL, not a native crypto-enablement
  switch.
- `src/components/encryption.ts` explicitly depends on Pantalaimon's decrypted sync events and its
  `decrypted` marker.
- `src/components/encrypted-intent.ts` routes encrypted-room sends through that proxy and
  synchronizes clients; it does not initialize a local Olm machine.
- The bot intent is constructed without the ghost encryption options.

The transitive `@vector-im/matrix-bot-sdk` version `0.10.0-element.0` does expose native Rust crypto
and Appservice `cryptoStorage`, but the framework does not pass those options through. Its
`CryptoClient.prepare()` initializes the Rust store with an empty passphrase, and its default
metadata provider writes JSON. Supplying a separate SQLCipher datastore to the bridge does not
change either behavior. Its media upload interface also accepts Buffer/string, so bounded streaming
must be evaluated separately.

## Consequences

The handoff's claim that the selected framework directly provides the intended encrypted
single-service integration is incomplete. Do not set the proxy URL to the real homeserver and assume
messages are encrypted. Do not pass Gate 0D on the basis of room encryption state, successful login,
or a local framework build.

## Next experiment

Use the existing SDK's Rust crypto through a small, explicit TypeScript integration: persistent
bot/ghost devices, crypto transaction delivery, encrypted send/decrypt/media, and a protected store
secret. Keep the selected framework for application-service semantics. Record any required
SDK/framework patch and test it against the pinned Beeper proxy before accepting the architecture.

No new protocol cryptography is authorized or required by this ADR. Adding a Pantalaimon process
would change the deployment architecture and must be an explicit decision; it has not been added.
Gate 0D remains unpassed.

## Protected native store experiment

`tests/probes/entry.matrix-native-persistence-probe.ts` now verifies that the pinned Rust binding
accepts a nonempty store passphrase, rejects an incorrect passphrase, preserves the device identity
across close/reopen, and decrypts a previously encrypted Megolm message after reopen. This runs
entirely offline with synthetic data. It does not exercise device-to-device key distribution,
application-service transactions, a process crash, or Beeper. The remaining integration must pass
this protected-store configuration through the SDK rather than use its hardcoded empty passphrase.

## SDK integration experiment

The tracked `integrations/matrix/overlay` now patches and recompiles the pinned SDK to require a
provider-supplied protected-store passphrase and permit SQLCipher-backed metadata without creating
`bot-sdk.json`. Original source fingerprints and the MIT license are preserved. Native
initialization also awaits device persistence and closes the machine when its initial outgoing
requests fail.

`entry.matrix-sdk-native-probe.ts` uses the actual SDK encrypted-send path and Rust engine with a
synthetic intercepted transport. It checks `m.room.encrypted` output, decrypts after close/reopen,
preserves identity and room metadata, and rejects incorrect keys and empty passphrases. No
homeserver connection, second-device key distribution or application-service transaction handling is
covered. The framework still needs explicit integration; Gate 0D remains unpassed.

## Two-device exchange and transaction order

`entry.matrix-device-exchange-probe.ts` passes with two separate real native SDK crypto machines.
Its synthetic transport routes genuine signed device keys, one-time-key claims and encrypted Olm
session-key messages. Messages decrypt in both directions and after both machines reopen. The
recipient first rejects the message before receiving the session key; no room keys are injected.

`src/matrix/native-transaction.ts` processes the pinned SDK's crypto transaction extensions before room
events and awaits event delivery. The probe delivers a key update and encrypted room message in one
transaction, rejects an unexpected recipient device, and propagates an asynchronous inbox handler
failure. This adapter is not an authenticated HTTP endpoint or durable transaction journal.
Framework wiring, other to-device control events, and actual Beeper round trips remain pending.
