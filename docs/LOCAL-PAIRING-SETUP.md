# Local pairing setup implementation

`src/setup/link-session.ts` connects backend linking states to a fresh-profile setup coordinator. It
refuses existing profiles/secrets, passes QR data through only to local setup state, and maps
confirmation emojis using the pinned upstream `EMOJI_LIST` and the same first-three-byte indexing as
Desktop. When the backend requests a password, it generates and atomically saves the recovery secret
before supplying it to the worker. Recovery acknowledgement is required before finishing.

Early cancellation stops the worker and removes only the fresh directory whose inode the attempt
created. Once a secret has been supplied, cancellation cannot delete the profile: synchronization
may already have registered the identity. A stop preserves those files for recovery. Live cleanup
and resumption at intermediate synchronization stages are not yet verified.

`setup-server.ts` provides the local API and always binds `127.0.0.1`. Its URL carries a random
token in the fragment, so it is absent from HTTP request targets. `/session` consumes that token
once and issues an HttpOnly, SameSite=Strict cookie. All other API routes require the cookie;
mutations require the exact listener origin. Host and Fetch Metadata checks reject cross-origin
access. Responses are uncached and request bodies are bounded. The default inactivity limit is 15
minutes; expiration stops unfinished work. Successful recovery confirmation closes only the setup
listener, retaining the completed backend for the bridge.

The browser page renders QR codes locally, displays confirmation emojis, and requires revealing
and acknowledging the recovery secret before finishing. It removes the initial URL fragment from
browser history and clears the displayed secret on completion. Static assets use a restrictive
same-origin Content Security Policy. QR images require authentication. Background polling does not
extend the inactivity deadline; authorization expires on the server.

Run `pnpm run build:setup-ui` before starting the server directly. The standalone operator launcher
builds the UI automatically:

```sh
pnpm run setup --data-dir /absolute/private/bridge-data
```

Use Node 24 and first build the pinned headless backend and WASM as described in
`docs/BUILDING.md`. The data directory's parent must exist. The launcher creates a mode-0700
data directory and `secrets/` directory, refuses public or symlinked directories, and refuses an
existing `threema/` profile or `secrets/threema-profile` secret. It prints a single-use local URL.
Linking begins only when the user selects Begin linking on that page.

For a remote machine, pass `--port 8787` and use `ssh -L 8787:127.0.0.1:8787 your-host` before
opening the URL locally. Keep this terminal open during pairing. Ctrl-C/SIGTERM closes setup and
stops its worker; an early incomplete profile is removed, while a possibly registered profile is
preserved. Successful acknowledgement also stops this standalone command's worker and retains the
profile. It does not start message bridging. The service can retain the backend by using
`startSetupServer` directly instead of the standalone wrapper.

The recovery page displays the linked Threema ID obtained from the backend user model after link
completion. The worker returns only the ID string, keeping the backend handle inside its worker.
Handoff to the running bridge remains pending. No live phone pairing or Beeper operation was performed.

```sh
pnpm run test:setup
pnpm run test:setup-http
pnpm run test:setup-standalone
pnpm run typecheck
```

Coordinator tests use a synthetic backend to check password ordering, recovery acknowledgement,
emoji vectors, cancellation cleanup and preservation of existing profiles. HTTP tests use synthetic
sessions on an ephemeral loopback port, including automatic expiry without an explicit close.
They also check page/script delivery, CSP, authenticated PNG generation and invalid asset paths.

For a synthetic browser session, run `node tests/entry.setup-ui-fixture.ts` after building the UI.
Open its printed URL, select Begin linking, and enter `confirm` then `ready` on the fixture's stdin
to advance the simulated backend. Enter `stop` to close it. This cannot link a real account.
Browser verification covered QR loading, emoji display, secret reveal and acknowledgement, completion
and secret clearing, including a 390px viewport with no horizontal overflow. Full accessibility and
live-account acceptance remain pending.

## Pair directly into the service layout

```sh
pnpm run setup --config /absolute/path/bridge.yaml
```

This mode reads the same strict YAML as service startup and uses its
`data_dir/profiles/<profile_id>`, `password_file` and `wasm_file`. Set `identity`
to the Threema ID you intend to link. Both the configured profile and password file
must be absent. The data directory's parent and the password directory's parent
must exist; setup creates/checks the immediate private directories. The secret
location must be writable during setup, then may be mounted read-only for service
use. `--config` and legacy `--data-dir` are mutually exclusive.

The coordinator compares the linked identity with the configured identity before
reporting readiness. A mismatch reports failure and preserves the possibly
registered profile and its persisted secret. It never deletes or relinks that
profile automatically. Inspect the account/configuration locally before choosing
recovery actions. The error and audit records do not print either identity.

Successful acknowledgement still stops the setup worker; start the service
separately with the same YAML. This closes the profile-path mismatch but does not
provision the separate Matrix crypto key, appservice registration or bbctl
credentials. Those prerequisites and successful live service acceptance remain
outstanding. The legacy `--data-dir` layout remains available for existing spike
workflows and does not automatically migrate any files.

## Initialize the separate Matrix store key

Before the first service startup, with private data and secret parent directories
already created, run:

```sh
pnpm run init:matrix-key /absolute/path/bridge.yaml
```

This creates a random 32-byte key at `matrix.crypto_key_file`, encoded for the
existing secret reader and atomically published with mode `0400`. It never prints
the key, changes the Threema secret, or contacts Beeper. Include the Matrix key in
an encrypted recovery backup along with the corresponding bridge/crypto stores.

The command refuses an existing destination or an existing
`data_dir/bridge/<profile_id>` directory, even if empty. It also rejects using the
Threema password path as the Matrix key path. It is an initializer, not a key
rotation or recovery command. If a key is missing for existing data, restore the
original backup; do not generate a replacement. Existing keys are left untouched.
Private owned real directories are required, including the secret's immediate
parent; this command does not create those directories.

This supplies the local Matrix key prerequisite. Appservice registration and
bbctl account provisioning still require their separate flows; successful live
setup-to-service acceptance remains unverified.
