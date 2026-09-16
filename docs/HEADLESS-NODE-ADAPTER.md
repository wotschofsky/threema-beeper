# Headless Node adapter status

The Desktop overlay now supplies `createNodeFactories` and `createNodePlatform`. The factories reuse
upstream SQLCipher migrations, key storage, filesystem storage and Zlib compression. They require an
absolute private profile directory, refuse legacy-profile access, refuse in-memory profile databases
and reject a new join when database/WAL files already exist. Database migration failures close the
opened backend. No Electron settings or file logger are loaded.

The platform adapters disable desktop notifications and thumbnail-cache refresh. Calls, thumbnail
generation, dialogs, updater/restart operations, certificate-pin modification and OnPrem services
fail explicitly with `UNSUPPORTED_HEADLESS_OPERATION`. These are capability boundaries, not
implementations of the later bridge media, management-alert and lifecycle features.

`probeMissingProfile` uses real endpoint proxies and the actual `Backend.createFromKeyStorage` path.
The offline test initializes early backend services and receives upstream's typed `no-identity`
error from a fresh directory. It also creates a real upstream database, runs its migrations, closes
and reopens it, and reads the empty contact repository. Upstream may consume and wipe database keys;
the probe supplies independent Uint8Array copies rather than Node Buffer slices.

After rebuilding the headless bundle, run `pnpm run probe:headless-lifecycle` with Node 24. The
focused upstream ESLint check and headless TypeScript check pass for these additions. No phone is
linked and no network connection is created by this probe. It does not prove a linked profile opens,
device joining succeeds, or the backend can shut down cleanly after connection.

Remaining Gate 0C work: a dedicated worker/child lifecycle, link-state and password controls,
cancellation, linked-profile reopen/recovery, offline-phone receive, canonical enumeration/watch,
and the send-ID correlation patch. Gate 0C remains open.

## Dedicated worker and link controls

`node-session.ts` now exposes upstream profile-open/device-join operations and forwards loading/link
states over its existing endpoint service. Password submission is accepted only in the expected link
state. Each session permits one initialization, and linking refuses an existing identity. A backend
handle remains inside the worker for subsequent model adapters.

`src/threema/backend-controller.ts` owns a dedicated Node worker and private request/result IPC.
Secrets are passed as messages, never command-line arguments. Link errors are reduced to typed
categories before reaching the parent; worker stdout/stderr are not forwarded. QR and rendezvous
hash data travel only through the explicit state callback. Termination rejects pending requests and
stops the entire worker; closing IPC ports alone is not presented as backend cancellation.

Initialization installs `self = globalThis` when absent because upstream DOM helpers use
`self.crypto`. It uses Node's existing Web Crypto implementation, and initializes libthreema's
panic/logger callbacks once per worker without forwarding private protocol diagnostics.

Tests:

```sh
pnpm run test:backend-worker
pnpm run probe:headless-link-boundary
```

The worker test covers a real missing-profile open, password submission in the wrong state, startup
cancellation, and idempotent shutdown. The link-boundary test runs upstream device join with only
the WebSocket constructor replaced by a deliberate failure. It checks typed connection failure; it
does not generate a QR or connect to a service. Cancellation during live synchronization, profile
locking, linked-profile persistence and graceful connected shutdown remain unverified.
