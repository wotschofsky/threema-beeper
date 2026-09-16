# Framework native encryption patch

`native-encryption.json` contains exact replacements and before/after SHA-256 fingerprints for
`src/bridge.ts` at the pinned `matrix-appservice-bridge` commit. The original file's Apache-2.0
header remains intact. `pnpm run prepare:matrix-framework` verifies the checkout, applies the patch
and compiles the framework. Apply the native SDK overlay first.

The patch adds an explicit `nativeEncryption` storage option, passes it to the framework's SDK
Appservice and rejects simultaneous proxy/native encryption configuration. Native mode refuses
`Bridge.listen()` because its legacy event listener omits native crypto transactions. Use the
authenticated durable ingress instead. Call `getIntent(user).botSdkIntent.enableEncryption()` before
using a native intent. Configuration alone does not prepare device crypto or enforce encrypted-room
send policy; the final service must enforce these invariants.

The login probe initializes the real patched Bridge, uses a real framework-backed intent and native
SDK crypto, and intercepts only the network transport. It verifies saved-token restart, stable
device identity, temporary-outage recovery without a second login, and refusal of the legacy
listener. It is still not a live Beeper gate pass.
