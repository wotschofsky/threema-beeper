# Profile processing runtime

ProfileRuntime assembles ProfileSynchronizer, TransactionWorker/Pump, MatrixJournalSink/JournalDelivery
and the guarded OutboxDispatcher for one already-open, exclusively owned profile. Startup verifies
the backend identity and Matrix crypto readiness before starting any loops. The concrete journal sink
receives the outbox so owner echoes use their original Matrix events. The transaction decoder and
native Matrix clients are supplied by the service; this assembly does not create credentials.

Inbound delivery waits for synchronization to be live and Matrix crypto to be ready. Outbound sends
also wait until the current metadata snapshot has been applied to Matrix. Queuing and decoding can
continue while synchronization is pending. A status snapshot exposes runtime state, readiness and
the four processing-loop states. This is processing readiness, not yet the complete health endpoint
or a claim that all unsupported features can be delivered.

Stop drops runtime readiness immediately, aborts the loops and terminates backend IPC concurrently
so blocked backend calls can settle. It awaits all loop shutdowns before returning; callers must close
SQLCipher and native Matrix crypto stores afterwards. Repeated stop shares the same shutdown. The
runtime cannot restart its terminated backend; restart requires a newly opened profile/runtime.
Wrong identity, unavailable Matrix crypto and interrupted startup trigger shutdown. A hung Matrix
HTTP request still needs service-level request deadlines; terminating the backend does not cancel it.

Tests use real SQLCipher stores and the actual processing loops with synthetic backend/Matrix
responses. They cover held reconciliation, metadata acknowledgement, transaction decoding, changing
crypto readiness, concurrent start/stop, complete loop shutdown, wrong-profile rejection and stop
during identity lookup. Root typechecking and both runtime tests pass.

The complete launcher remains unfinished: configuration and secret derivation, bbctl registration/
proxy, native crypto/framework startup, saved-profile opening, HTTP ingress/health binding, signal
handling and store closure must be wired around this class. Matrix control-event handling and remaining
message/media features also remain incomplete. No live account was opened for these tests.


## Service configuration

config.example.yaml contains placeholders only. readServiceConfig reads at most 64 KiB from a real
file opened without following a symlink. parseServiceConfig uses the pinned YAML parser with strict
keys, duplicate-key rejection and alias expansion disabled. Unknown fields and inline credential
fields fail. Parse/validation errors do not include YAML snippets or field values.

Configuration distinguishes the opaque profile directory ID from the eight-character Threema
identity and Matrix owner. Paths must be absolute and normalized; profile paths are derived under
the configured data directory. Matrix homeserver configuration requires an HTTPS origin without
credentials/query/fragment; the listener remains loopback. Duration, page size, port and media limits
are bounded. Encryption, reconciliation and automatic media retention cannot be disabled in this
implementation, and unsupported optional feature/logging flags cannot be enabled.

The schema follows the handoff's bridge section and adds explicit data directory, identity, owner,
WASM path, homeserver and crypto-key-file references required by startup. bbctl registration remains
a separate referenced document; this parser does not consume a populated registration or its tokens.
ProfileRuntime accepts synchronization page size/period, and ProfileSynchronizer now applies its
configured page size to both history requests and response validation (1–500).

The full launcher has not yet connected every parsed setting: max_buffered_events, startup timeout,
media setup, private-data-directory validation and key loading still need application during resource
initialization. Parsing these fields is not evidence they are enforced at runtime. A standalone JSON
Schema and complete startup command are also outstanding.

Seven focused configuration/runtime/synchronization tests and root typechecking pass. Tests cover the
example config, invalid/unsafe/unsupported settings, source-value redaction, symlink/size refusal and
existing lifecycle/reconciliation behavior. No production secrets or accounts were read.


## Private startup resources

openBridgeResources validates the existing data root as a private directory owned by the current
user, then creates/checks profile, per-profile bridge, Matrix and runtime/media directories without
following child symlinks. It refuses public/wrong-owner directories and media paths outside the
runtime tree. It acquires exclusive OS-backed locks for both the per-profile bridge directory and
media temporary directory; two profiles cannot run cleanup against the same active media directory.
These service locks are separate from the backend's Threema profile lock.

The configured Matrix crypto master-key file uses the existing mode-0400, 43-character base64url
32-byte secret format. No master key is generated or replaced at startup. HKDF-SHA256 separates
journal, inbox, portal, outbox and Matrix keys by version, opaque profile ID, Threema identity and
purpose. The factory opens all four SQLCipher stores with those derived keys and exposes a separate
Matrix key/directory for native/appservice initialization. Temporary key buffers are wiped after
opening; the retained Matrix key is wiped on resource closure.

Database files are created mode 0600; existing main/sidecar files must be private owned regular files.
Initialization failure closes already-opened stores and releases locks without deleting data. Close
is idempotent and releases stores in reverse order. Native Matrix clients must stop before resources
close. Directories created during a failed initialization remain available for an operator to inspect.

Tests use real encrypted stores and verify reopen persistence, Matrix/inbox key separation, exclusive
bridge/media ownership, key wiping, wrong-key failure followed by successful reopen, private-directory
checks, escaping media paths and symlink refusal without modifying the target. Both focused tests and
root typechecking pass. Native Matrix initialization, full startup timeout/HTTP lifecycle and final
resource closure in a launcher remain unfinished; no live profile or production key was read.


## Appservice registration loading

The service registration loader uses the pinned matrix-appservice AppServiceRegistration parser after
validating credential-bearing YAML. Input is bounded to 64 KiB, with duplicate keys/aliases rejected;
readRegistration requires an owned private regular file opened without following a symlink. Validation
and load errors use fixed messages without token values or YAML snippets. The read buffer is wiped;
framework token strings necessarily remain available in memory for authenticated requests.

The registration URL must match the configured loopback HTTP listener and port, with no credentials,
query, fragment or path. IDs/tokens/localpart, namespace arrays/regular-expression syntax, optional
rate-limit/ephemeral flags and protocols are checked. Appservice/homeserver tokens must differ and the
bot cannot be the configured owner. Matrix domain is derived from the owner ID, not the homeserver
HTTP hostname. Unknown root metadata from registration generators is not passed into the framework.
Namespace coverage for generated ghosts and current bbctl-generated live registration compatibility
still require validation; regex compilation alone does not establish correct namespace policy.

Three focused registration tests and root typechecking pass. Tests construct the actual pinned
framework registration with synthetic tokens, reject malformed/mismatched input with fixed errors,
and enforce file permissions/symlink refusal. This is a read-only loader; it does not register a bridge,
modify the source registration, access Beeper, or start native Matrix crypto. The full launcher is
still unfinished.


## Native Matrix session assembly

openMatrixSession initializes the pinned patched framework with ProtectedAppserviceStorage and native
crypto, then enables the registration's bot intent. It exposes the bot, profile-scoped ghost intents,
a decoder, readiness and asynchronous close. Client tracking happens after native enableEncryption,
which can swap the SDK's underlying client during appservice login. Owner/different-profile intents
are rejected; double puppeting is not silently enabled.

The transaction decoder routes encrypted room events only through locally mapped portals belonging
to this profile and the existing ready bot client. To-device updates use the existing initialized
client map. Unknown recipients do not create identities from inbound data. Ghost clients become
available as the journal's metadata path initializes them. Control-event handling and restoration of
all needed ghost crypto clients before transaction decoding remain unfinished.

Close prevents new operations, awaits in-flight encryption setup, closes tracked native crypto clients,
then closes the framework and encrypted storage. Repeated close shares one promise. Initialization
failure performs the same cleanup. Matrix request timeouts and cancellation still need launcher/HTTP
integration; a network operation that never settles can delay shutdown.

The service-level test uses real native crypto and protected stores with a synthetic Matrix HTTP
transport. It proves initial bot login, device-key/token persistence across restart, no replacement
login on verification outage, successful recovery, profile/room rejection and repeated close. Root
TypeScript checking and the focused test pass. No Beeper account or live registration was accessed.

This component is not yet a complete runnable launcher. It still uses the experiment's native storage
and transaction adapters, and framework room/user/event-store compatibility, application-wide log
redaction, successful linked-profile end-to-end behavior and bbctl proxy acceptance remain open work.


## Experimental service launcher

pnpm start /absolute/path/config.yaml now assembles the configuration/registration loaders, private
resource stores, saved-profile opener, native Matrix session, media renderer, transaction HTTP server
and ProfileRuntime. It refuses a mismatched Threema identity before Matrix initialization and never
falls back to linking. The HTTP listener binds the configured loopback address/port. Transaction
acceptance remains durable before asynchronous processing, with delivery readiness gated by profile
reconciliation and applied metadata.

Startup checks its cancellation/deadline signal between stages and passes it to saved-profile opening;
media streams receive the lifetime signal. Successful startup clears the startup timer. SIGINT/SIGTERM
trigger shutdown: stop readiness/loops, close the listener and active connections, terminate the
backend, close native Matrix state, then close stores and wipe retained resource keys. Repeated close
shares one promise. The CLI emits fixed messages and suppresses raw bot-SDK diagnostics; a full audit
of framework/native logging is still needed.

Cancellation during native Matrix initialization currently waits for that initialization to settle
before resources can safely close. Thus startup_timeout prevents further startup steps but is not yet
a strict wall-clock termination bound for every HTTP operation. Existing SDK HTTP timeouts remain in
force. max_buffered_events still needs end-to-end enforcement, and health routes, control-event
handling, native framework store integration and successful linked/live service startup are pending.

A focused test runs the actual launcher up to an empty temporary profile using real Node backend
workers, WASM, registration parsing and encrypted stores. It confirms a fixed startup error, released
resource locks, repeatable failure and already-aborted startup. No Matrix network connection occurs
because missing profile identity fails first. Root typechecking and this test pass. This establishes
failure cleanup only, not a successfully running bridge or Gate 0 completion.


## Loopback liveness and readiness

The launcher now exposes GET/HEAD /livez and /readyz on the transaction listener. The paths require no
appservice token but return only {ok: boolean}, never account IDs, tokens, queue contents or underlying
errors. Responses disable caching and use 200/503. All transaction routes retain their existing bearer
authentication; adding health routes does not authorize transaction ingestion.

Liveness describes the running Node listener/lifetime independently from profile/crypto/store
readiness. The launcher keeps readiness false until ProfileRuntime reports live reconciliation and
applied metadata, then also checks each opened encrypted database can read its schema. Probe failure
returns unavailable rather than exception details. Connection checks are not a full integrity scan,
proof of future writes/free disk, or live connectivity tests. Native crypto readiness also does not
prove a currently working Matrix network connection.

Real loopback HTTP tests cover ready/unready/live transitions, HEAD responses, fixed body projection,
no-store headers and failed probes, alongside existing auth/body-limit/durable-ingress checks.
Resource tests check healthy and closed-store states; real-worker startup cleanup still passes. Root
typechecking passes. The HTTP test required permission to bind an ephemeral loopback port because the
sandbox denied listen; the permitted test passed and closed its server.

The full handoff health dimensions—supervised bbctl process, proxy reachability, detailed Threema/
Matrix connection states, media degradation, integrity/disk checks and external dead-man monitoring—
remain unfinished. These endpoints are an initial operational interface, not proof of full readiness
against every release criterion.

## Reconciliation event limit

`bridge.sync.max_buffered_events` now reaches the profile synchronizer. It bounds live
message observations staged across all chats during one snapshot epoch (including repeated
edits), independently of the journal's byte limit and transport queue bounds. The default
is 10,000; valid values are 1–100,000. An observation beyond that bound aborts the epoch,
keeps message delivery gated, cleans up subscriptions and staged records, and retries a
fresh subscribe-before-enumerate reconciliation. The count resets for each new epoch;
ordinary live delivery after commit does not consume this staging budget.

The offline regression covers overflow shared across two chats, a source catching the
callback rejection, absence of partial publication, cleanup, recovery at the exact limit,
and continued live processing afterward. It does not establish production throughput under
sustained overflow or the handoff's 100,000-message performance targets.

## Profile replay ordering

Profile publication now applies all selected snapshot rows before any selected live rows,
then replays live observations in the journal's global numeric insertion sequence across
chats. Both phases and metadata remain in one transaction. Reads use batches of 16 rows
and a phase/sequence index; unrelated reconciliation tokens are left untouched. The
single-chat API uses the same replay implementation. Pending delivery explicitly sorts by
the integer database sequence rather than the string representation returned to Node.

The regression stages 40 alternating cross-chat edits before snapshot enumeration, commits,
reopens SQLCipher, and checks snapshot-first and exact observed live order. Existing metadata
failure injection still verifies rollback of the whole publication transaction. This does not
replace live reconnect, hard-kill, or large-history performance acceptance testing.

## Outbound reply text and unavailable targets

Owner text replies now remove the leading Matrix plain-text quote fallback when resolving
`m.in_reply_to`, preserving the actual reply's whitespace. Mapped targets use their remote
message ID. An unmapped target no longer stays pending indefinitely: the outbox receives
plain text marked `Reply fallback: original unavailable`, plus at most 320 Unicode code
points from the client-supplied quote when available. That excerpt is explicitly labelled
client-provided rather than treated as authenticated original content. No HTML is interpreted.
Quote-only/empty replies remain invalid; non-reply messages retain their original text.

The stripping rule follows the [Matrix rich-reply specification](https://spec.matrix.org/v1.9/client-server-api/#stripping-the-fallback).
Durable ingress tests exercise mapped replies, unmapped fallback queueing, native target IDs,
and existing replay/encryption guards. Fragmented and deleted-target reply handling still
needs its separate implementation and acceptance coverage.

## Appservice user namespace checks

The private registration loader now rejects an exclusive user namespace matching the owner's
MXID. Every ghost intent request must both belong to the active profile's canonical identity
space and match an exclusive user namespace in the loaded registration. The check runs before
framework intent creation; nonexclusive matches are insufficient. The registration's sender bot
remains special and does not need an explicit ghost-namespace match.

Tests use the actual framework matcher with exclusive, nonexclusive, and missing entries and
confirm rejected ghosts cause no additional login. These are local checks of the supplied file,
not proof that the homeserver installed the same registration. Coverage of all future contacts
is checked as each intent is requested; startup does not prove arbitrary regex coverage of the
entire identity space. Live bbctl registration and alias namespace validation remain pending.

## Portal alias registration guard

The launcher now supplies a registration-backed alias assertion through `ProfileRuntime` and
`MatrixJournalSink` to `PortalManager`. Each generated stable portal alias must match an
exclusive alias namespace before crypto activation, alias resolution, room creation or mapping
writes in that manager. Existing mappings still undergo both the local alias check and remote
room ownership/encryption verification. Rejected metadata remains pending for retry after
configuration repair. Generic portal-manager callers can supply their own assertion.

The current generated alias is `#threema_<40 lowercase hex characters>:<domain>`; for example,
a synthetic `example.invalid` registration can cover it with an exclusive alias regex
`^#threema_[0-9a-f]{40}:example\.invalid$`. This is the current local adapter convention,
not a completed Beeper deployment recipe. The handoff requires preserving Beeper's `sh-`
namespace, and that bbctl naming integration still requires implementation and verification.

## Appservice domain is explicit

`bridge.matrix.domain` is now required and independent of both the owner's MXID domain and
`bridge.matrix.homeserver` (the HTTPS API origin). The registration loader uses this configured
server name for the sender bot; the launcher passes the same domain to ghost and portal
construction. Existing config files must add the field. The current adapter accepts DNS/IPv4
server names with optional numeric ports; IPv6 Matrix server names remain unsupported.

Evidence from pinned bbctl: `cmd/bbctl/register.go` returns `homeserver_domain: beeper.local`
separately from `your_user_id` and `homeserver_url`. Configure the reported domain; do not infer
it from the owner. The example YAML retains synthetic `example.invalid` values.

Clarification of earlier namespace notes: `cmd/bbctl/bridgeutil.go` requires the *bridge name*
to start with `sh-`. That is not evidence that every ghost or alias localpart literally starts
with `sh-`. Actual user/alias patterns must come from the returned registration. The current
hardcoded localpart conventions still need integration with that registration format; simply
renaming them to `sh-threema` would not establish compatibility.

## bbctl JSON registration input

`bridge.matrix.registration_file` can now contain the JSON envelope produced by pinned
bbctl's `register --json` command, as well as a plain local registration YAML. Before using
nested credentials, the loader requires `your_user_id`, `homeserver_domain`, and the HTTPS
`homeserver_url` origin to match the configured owner, Matrix domain, and homeserver. Paths,
credentials, fragments and queries in the reported homeserver URL are rejected. Duplicate
keys and size/file-permission checks apply to JSON too.

For this verified envelope only, a registration URL of `websocket`, empty string or null is
adapted in memory to the configured loopback HTTP listener. An explicit URL must already
match that listener. Sender, tokens and namespaces retain their registration values; the
input file is not modified. Plain YAML still requires an explicit local HTTP URL.

This does not yet launch bbctl or register an account. Pinned bbctl proxy reads a standalone
registration file and requires its URL to point to local HTTP; exporting that private file
and supervising the proxy are still pending. Do not pass the JSON envelope directly to
bbctl proxy as if it were the standalone registration YAML.

## Private standalone proxy registration export

`pnpm run export:proxy <config.yaml> <new-registration.yaml>` loads the configured private
registration (plain YAML or verified bbctl JSON) and emits standalone YAML with the normalized
loopback URL. This is the file format consumed by the pinned bbctl proxy registration loader.
The command does not launch bbctl or contact either account.

The destination's parent must be an existing private directory owned by the current user and
specified through its real path without symlink ancestors. The export writes mode 0600 to a
unique temporary file, fsyncs it, atomically links it to the destination without replacement,
removes the temporary name, and fsyncs the directory. Existing files or links are preserved.
A reported failure after publication can leave a complete destination; retries deliberately
refuse to overwrite it. Tokens are never printed and the source registration stays unchanged.

Offline tests validate round-trip loading, endpoint/tokens, permissions, source preservation,
existing-file/link rejection, public-directory rejection, concurrent publication, and cleanup.
Actual bbctl parsing/execution, process supervision and live compatibility remain unverified.

## Foreground process supervisor

`ProcessSupervisor` owns one foreground child with an absolute executable, argument array,
explicit environment and no shell. Child output is discarded to avoid forwarding unaudited
credential-bearing diagnostics. Failures restart after bounded exponential backoff; sustained
uptime resets that backoff. Status observers cannot break process ownership.

Stop interrupts backoff or sends SIGTERM, escalates to SIGKILL after the configured deadline,
and waits for the child close event before releasing ownership. Clean exit remains terminal:
the pinned bbctl WebSocket loop exits cleanly when a competing connection replaces it, so
blind restart would risk a connection takeover loop. The supervisor does not infer WebSocket
connectivity from a live process and supervises a single foreground process, not descendants.

Three tests run real Node fixture processes for failed-start/restart/clean-exit behavior,
observer failure, an ignored SIGTERM, verified child disappearance, and interruptible spawn-error
backoff. This library is not yet connected to the service launcher. Verified bbctl executable
selection, proxy arguments/environment, readiness wiring and live testing remain pending.

## Checksum-pinned executable verification

The process supervisor accepts a SHA-256 pin and verifies the executable before every launch,
including retries. Verification reads through a bounded 64 KiB buffer, caps files at 256 MiB,
checks file metadata before/after hashing and checks the pathname still references that inode.
It rejects symlinks, group/world-writable files or ancestor directories, non-executables and
files owned by someone other than root/current user. Cancellation interrupts verification.
A verification failure enters backoff without spawning a child.

This supports a documented host-supplied binary but does not select an official bbctl release
or establish the provenance of a supplied checksum. It assumes the current user/root and the
installation path are trusted; it is not descriptor-based execution immune to replacement by
that same trusted user between verification and spawn. Production images should keep the
binary installation read-only. Launcher configuration and bbctl integration remain pending.

## Launcher-owned bbctl proxy

An optional `bridge.proxy` object enables supervision with four required fields:

```yaml
  proxy:
    binary: /app/bin/bbctl
    sha256: <verified lowercase SHA-256 for that executable>
    config_file: /run/secrets/bbctl-config.json
    registration_file: /data/bridge/proxy-registration.yaml
```

Omitting the object keeps the external-proxy workflow. The checksum placeholder above must
be replaced with an actual verified pin; no release binary or digest is silently selected.
Preparation verifies the executable, requires private explicitly supplied credential/registration
files, rejects symlink paths, and compares the standalone proxy registration with the service's
validated source registration. JSON metadata envelopes cannot be passed directly to proxy.
The credential file is not discovered from the user's home or printed; its bbctl semantics are
left to the pinned executable.

The child receives `--config <file> --env prod --color never proxy --registration <file>` and
an explicit locale-only environment. It starts only after the loopback transaction listener
binds. Shutdown begins stopping the processing loops, stops/awaits the proxy, then closes HTTP
and remaining resources. Readiness additionally requires the supervised process to be running;
`status().proxy` reports its state or `external`. A running child is not proof of an established
WebSocket connection. Existing durable processing loops keep their own readiness/retry gates.

Tests cover configuration parsing, pin and private-file validation, mismatched registrations,
no execution during preparation, process lifecycle and existing failed-service-start cleanup.
Successful full launcher startup with a real linked profile and bbctl remains unverified.
Automatic private export/rotation, selected release pins, actual namespace adaptation, credential
account/environment validation and WebSocket-level health remain pending.

## Preserve the bbctl API route

The pinned hungryapi client returns its homeserver URL under
`https://matrix.<environment-domain>/_hungryserv/<username>`. Configuration and bbctl JSON
validation now preserve this per-owner route instead of rejecting it or reducing it to an
origin. Both normal HTTPS origins and the exact configured owner's hungryserv route are
supported; a different user's route, extra path segments, query parameters and URL credentials
are rejected. An optional trailing slash is normalized. The full endpoint reaches the existing
Matrix session constructor. Actual SDK traffic through Beeper remains unverified.

The proxy's explicit environment now supplies platform config/data defaults rooted at the
service data directory (`HOME`, `XDG_CONFIG_HOME`, `BBCTL_DATA_HOME`). Pinned bbctl resolves
these during initialization even when `--config` is supplied; locale-only environment would
fail that initialization. It still receives no inherited account tokens or personal home path.
Credential structure/account checks remain pending.

## Explicit bbctl production credential checks

Proxy preparation now reads the explicit private credential file through its checked descriptor
with a 1 MiB bound and wipes the read buffer. The file must be JSON without duplicate keys,
include a device ID and a production environment with a saved username and a supported token
prefix (`syt_`/`bat_`). The username must match the configured owner on `beeper.com`; the
appservice domain must be `beeper.local`, and the configured API must be the production origin
or that owner's hungryserv route. Supervised staging/dev environments are not yet implemented.

The selected environment cannot use `desktop_data_dir`: that tells bbctl to read a separate
Desktop login. All non-null environments must have an absolute `bridge_data_dir`, since pinned
bbctl fills missing directories and saves the file while loading even unused environments.
These checks preserve the intended explicit-credential startup path and fail with fixed errors.
No token or username is returned by the validator or printed in diagnostics.

Tests cover wrong/missing username, unsupported/missing token, Desktop indirection, missing data
directory, wrong account domain/API and duplicate JSON fields. This is local structural and
configuration consistency checking, not server-side token ownership/validity verification.
A trusted owner could also change the file after preparation; credentials are not snapshotted
into immutable runtime storage. Live authentication and complete proxy startup remain pending.

## Source version command

`pnpm run version --json` (or `node src/service/entry.version.ts --json`) emits machine-readable
source provenance without importing the bridge runtime, opening credentials/profiles, executing
dependencies or accessing the network. It includes pinned upstream repository revisions, the
SDK overlay version, project source/patch/test/documentation hashes, an aggregate manifest hash,
and the executing Node/platform/architecture. Paths are project-relative and ignore local clones,
dependencies and hidden/generated workspace data. Invocation is independent of working directory.

Release version is currently null. Installed dependencies, native artifacts, upstream checkout
contents and the actual configured bbctl executable are explicitly `not-checked`; this is not a
complete release SBOM or an attestation of built binaries. Adding build-time artifact hashes and
verified installed dependency provenance remains necessary for the handoff's full version manifest.
The regression runs the CLI from a different directory, compares deterministic JSON output and
checks a source-file hash independently.

## Explicit full reconciliation

The running service now exposes `resync(): boolean`. An accepted request drops live readiness,
invalidates the active synchronization epoch, waits for subscription/staging cleanup, and starts
one fresh subscribe-before-enumerate snapshot. Requests pending during the same cleanup coalesce.
Requests during failure backoff interrupt the wait; stopped/stopping runtimes reject them.
The operation reuses the already-open profile and does not change credentials or clear durable
Matrix/outbox queues. In-flight backend reads still need to return before cleanup can finish.

For a successfully started foreground CLI service on Unix, `kill -USR2 <node-service-pid>` requests
resync and produces a fixed confirmation line. The signal handler is installed after startup and
removed during shutdown; target the running Node service, not bbctl or an unstarted process.
The management-room `resync` command and authenticated administration interface remain pending.

Regression coverage confirms retry interruption, duplicate request coalescing, fresh metadata
epoch, immediate live-readiness drop and subscription cleanup without reopening the profile.
The signal route has been typechecked but not exercised against a fully linked running service.

## Configurable registered Matrix namespace

`bridge.matrix.namespace` now selects the prefix used for ghost localparts and stable portal
aliases. Set it to the registered bridge name, for example `sh-threema`, for a new self-hosted
Beeper installation. The pinned bridge-manager templates use `<BridgeName>_...`. Values are
1–32 lowercase ASCII letters, digits or hyphens; omitted values retain `threema` for existing
local fixtures. Supervised production proxy preparation additionally requires an `sh-` name.

Ghosts remain profile-scoped with reversible hex identities; portal aliases retain their existing
hash suffix. The selected namespace reaches message, reaction and receipt intents, native
session allowlisting, membership reconciliation and portal creation. Actual exclusive registration
matches are still required; selecting a name is not proof that the returned namespaces cover it.

Do not change a namespace for an existing deployment as if it were a display name. Existing
ghost mappings detect mismatched identities; no identity, room or crypto migration is performed.
Tests cover default and custom ghost convergence/stale membership removal, custom native session
allowlisting and custom alias creation/recovery, plus configuration bounds. Live Beeper-issued
registration coverage and cross-namespace migration remain unverified/unimplemented.

## Loopback metrics

GET/HEAD `/metrics` on the existing loopback listener now serves Prometheus text exposition
with fixed gauge names: `bridge_process_up`, `bridge_ready`, `bridge_sync_live`,
`process_uptime_seconds`, `process_resident_memory_bytes`, and `bbctl_proxy_up` when supervised.
External proxy state is omitted rather than reported as known down. Process-up is lifecycle
state and proxy-up is child-process state; neither asserts remote connectivity. The endpoint
shares the current health readiness computation and requires no transaction bearer token.

No labels, paths, user/room/message IDs, arbitrary callback fields or error strings are emitted.
Invalid snapshots or collector errors return fixed HTTP 503 responses without partial metrics.
The HTTP regression validates scrape/HEAD/error behavior alongside existing transaction auth
and durability checks. Queue/counter/histogram, connection-state and media metrics required by
the remaining observability work are not implemented yet.

## Durable queue gauges

Metrics now include current counts from encrypted stores: journal changes awaiting delivery,
raw transactions awaiting decoding, decrypted inbox events awaiting handling, and outbound
requests in PREPARED, DISPATCHING, SENT/awaiting-echo, and OUTCOME_UNKNOWN states. Completed
rows are excluded. Journal/outbox counts are scoped to the active profile; no profile ID becomes
a metric label. Indexes support state/count queries without loading message bodies into Node.

The renderer exposes fixed `bridge_*` gauge names for each stage, validates nonnegative safe
integer counts, and fails a scrape if store access fails instead of reporting false zeros.
These are current state gauges, not cumulative totals; uncertainty can fall after reconciliation.
They are not summed into a claimed count of distinct messages, since stages have different units.
Tests exercise ack removal, SQLCipher reopen/recovery, awaiting-echo/ACKED transitions and profile
isolation. Query cost at production-scale retained history still requires performance validation.

## Verified official bbctl release pins

`docs/BBCTL-PINS.json` records official v0.15.0 assets, sizes, SHA-256 digests, release ID and
release commit `649659929de880afdb24503f8908c5cf3da3a20e`. Linux amd64/arm64 and macOS arm64
binaries were downloaded into ignored `.local/bin/bbctl-v0.15.0/`, hashed, and checked against
both GitHub's asset digests and the official `sha256sums.txt`. macOS amd64 is listed from release
metadata but explicitly not download-verified. This is checksum verification, not a reproducible
build or signature attestation.

The pinned source checkout remains `621b50c3c9e395eda28ebe522a1406fdef71c8c9`. Compared with the
release, proxy/authconfig/main/hungryapi code is unchanged; inspected register.go differs only
by adding the unrelated `meta` bridge-type alias. No checkout or source pin was silently moved.

The official macOS arm64 executable passed `--version` and `proxy --help` in a clean, service-scoped
environment without loading credentials. Linux ELF architecture/static-link metadata was inspected;
Linux execution and a live proxy connection are not proven. Set `bridge.proxy.binary` to the
installed platform binary and `sha256` to that asset's manifest value. The launcher still verifies
the actual executable before launch/restarts. Image inclusion and cross-platform runtime smoke
checks remain pending.

Source: https://github.com/beeper/bridge-manager/releases/tag/v0.15.0

## Linux bbctl dependency smoke checks

`pnpm run probe:bbctl-linux` verifies downloaded binary pins and runs `--version` and
`proxy --help` for official Linux arm64 and amd64 binaries in pinned Debian trixie-slim images.
It uses per-architecture child image digests to avoid the local daemon's multi-platform index
collision. Containers run as UID/GID 65534, with no network, no capabilities, no-new-privileges,
a read-only root and binary mount, and a small temporary filesystem. No credentials or profile
volumes are mounted. Results are written only after all four checks pass.

All four checks passed; the captured report is `docs/BBCTL-SMOKE-RESULTS.json`. Host architecture
was arm64, so amd64 execution used emulation, not native amd64 hardware. This establishes basic
Linux binary execution/CLI compatibility only: it is not a full bridge image, native dependency
persistence test, proxy connection test, or completion of Gate 0E. Native amd64 and full service
container/runtime validation remain pending.

## SDK wire-route verification

The native Matrix session regression now intercepts the SDK's final request function rather
than replacing `MatrixClient.doRequest`. It asserts every generated request preserves
`/_hungryserv/owner/_matrix/...` and the configured HTTPS origin. The test exercises real
framework/native-crypto initialization, appservice login, key upload, device identity reopen,
whoami failure/recovery, read receipts and media upload through actual SDK URL construction.
Synthetic HTTP responses terminate requests in-process; no network or user account is used.

This strengthens the endpoint evidence: configuration acceptance and high-level mocked methods
alone did not prove wire URL preservation. It still does not prove Beeper server acceptance,
real authentication or a working appservice proxy. Actual remote behavior remains a live gate.

## Owned-room state reaches bot crypto

After applying transaction key/device updates, the Matrix session now forwards membership,
encryption and history-visibility state events from mapped active-profile portals to the bot's
native crypto `onRoomEvent` before publishing the decoded inbox event. Unknown/foreign rooms
do not reach that tracker. If the tracker rejects, the transaction worker retains the transaction
for retry rather than acknowledging successful decode. Replayed state remains subject to the
SDK's idempotent tracking behavior.

The native-session regression exercises a joined-member event through the real crypto tracker,
verifies foreign-room exclusion, and injects a tracker failure to check publication is withheld.
This covers the bot tracker only. Per-ghost room-state routing, dedicated state-event consumption,
full membership/device-removal acceptance and SDK tracker error-swallowing paths still require
work; fresh recipient checks at send time remain the current protection for outbound encryption.

## Tracker member lookup failure is retryable

The SDK overlay no longer swallows `getRoomMembers` errors when the bot crypto tracker handles
an encryption-state event. That error now propagates through native transaction decoding, so
inbox publication is withheld and the durable transaction can retry. The regression injects a
real SDK HTTP member-lookup failure, asserts no emitted event, restores the response and verifies
publication on retry. Other SDK room-tracker caching/failure behavior remains unchanged and
requires its own review; this fix does not establish full membership-removal/key-rotation handling.

## Per-client owned-room crypto state routing

The session now restores each initialized native client's joined-room list, filters it to owned
profile portals, and calls the SDK room-join tracker before installing that snapshot. Registration
and state application are serialized so events cannot overtake initialization. Room state reaches
the bot and initialized participating ghosts only; self membership events update ghost participation,
and successful local join/leave operations update the same routing set. Failures propagate through
decoding for durable retry. Unknown rooms never reach the tracker.

This replaces bot-only state forwarding. Synthetic multi-client router tests cover restore/join/leave,
foreign-room exclusion, queued initialization and tracker failure/retry; the real native bot-session
regression remains passing. Real multi-ghost restart/key-rotation acceptance is still required.
Snapshots use the SDK joined-rooms API (validated to at most 100,000 rooms), not paginated server
history. Dedicated state-event consumption and all live membership behavior remain incomplete.

## Native ghost restore evidence

The native-session regression now initializes both the bot and a real SDK/native-crypto ghost,
with separate synthetic appservice login tokens/devices and SQLCipher-backed crypto storage.
It verifies joined-room restoration routes an encryption-state event into the ghost's actual
crypto tracker, a leave event removes subsequent routing, and reopening the session preserves
the ghost Ed25519 identity without a second login. Restored room state again reaches that ghost.
All SDK HTTP requests are intercepted at the final request boundary and retain the hungryserv
prefix. No account or network connection is used.

This closes the gap between the lightweight multi-client router test and the actual native ghost
integration for those cases. It still does not demonstrate encrypted message delivery to/removal
of real Beeper devices, group churn under failure, or complete state-event consumption.

## Durable state-event consumer

A separate bounded state worker now scans the decrypted inbox, advancing past timeline events
and unsupported state so neither can starve later work. The running service owns its polling
lifecycle and reports `stateEvents` status. Events lacking source transaction provenance remain
pending. A successful handler result is required before acknowledgement; thrown errors retain
the event while allowing subsequent rows to progress. Restart resumes from durable inbox state.

The initial production handler supports encryption/history-visibility state on mapped owned
portals only. It reapplies native room tracking before acknowledgement, even if decoding already
tracked it; this also handles records retained from earlier runs without assuming prior effects.
Membership requires additional portal/admin policy and remains pending, as do unsupported and
foreign state. No Matrix group-administration event is forwarded to Threema by this consumer.

Tests cover skipped-row pagination, failure without starvation, SQLCipher reopen, selective
acknowledgement, shutdown, and actual native handler ownership/failure/success behavior. The
management-room and membership-policy consumers remain incomplete; this is not full state-event
acceptance or proof of live device rotation.

The normal service launcher now enables the mutation pump. Matrix replacements/redactions use
owned target mappings, the durable mutation journal, upstream edit/delete policy and uncertainty
recovery. Original-event retrieval is provided by the existing encrypted Matrix session with
fresh room authorization and the mutation shutdown signal. See `MESSAGE-MUTATIONS.md` for tested
scope and remaining phone-originated owner-edit/live compatibility work. Startup still requires
an already-linked profile; this wiring does not pair or operate an account by itself.
