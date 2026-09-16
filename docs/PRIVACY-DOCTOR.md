# Local privacy diagnostics

Run with Node 24 from the project checkout:

```sh
pnpm run doctor --privacy /absolute/path/bridge.yaml
```

The command emits JSON describing configured storage and credential paths,
filesystem modes, ownership, configured encryption, logging restrictions and
retention gaps. Exit status is 0 when every listed path exists with private
permissions and ownership (optional absent SQLite sidecars are allowed); 1 means an unsafe, missing or inaccessible path, or an
unreadable/invalid configuration. Incorrect arguments return 2. A profile that has
not yet been set up will therefore report missing paths.

Only the non-secret service configuration is read. The command inspects path
metadata without opening secret files, databases, media or profile locks. It does
not initialize directories, unlock databases, pair a device or contact a service.
Symlinks at inspected paths or in their ancestors are reported as unsafe. File
contents, Matrix access tokens, owner IDs and Threema identity values are not
included. Paths can contain identifying names; keep this report local.

The report deliberately separates configured encryption from runtime verification.
It does not verify an existing database's encryption, check every descendant, inspect ACLs, prove upstream telemetry is disabled, validate backup
encryption, or check the external log collector's retention. Database retention
limits and backup policies are not yet configurable in the bridge. These gaps are
reported rather than represented as passing checks.

This is the local privacy portion of the required doctor facility. Broader runtime
diagnostics (profile lock, connectivity, proxy state, clock skew, disk space,
media dependencies) and the encrypted management-room command remain outstanding.

## Local operational probes

```sh
pnpm run doctor /absolute/path/bridge.yaml
```

Without `--privacy`, doctor includes the privacy report and performs additional
local checks. It queries available filesystem bytes, writes and synchronizes a
small file in a newly created private `.doctor-write-*` directory beneath the data
directory, then removes that directory. It skips this probe if the data directory
fails the private ownership check. An abrupt process termination can leave the
probe directory behind; it contains only a fixed diagnostic string.

If a managed proxy is configured, its existing executable is checked against the
configured checksum and permission requirements without being executed. Existing
profile, bridge and media coordination databases are opened read-only with zero
busy timeout. A locked database is reported as an observed exclusive lock, not as
proof that the correct service owns it. Missing coordination databases are not
created. No lock is removed or acquired, and observations can change immediately
after the check.

Runtime connection, adapter compatibility, media runtime dependencies and
clock-skew checks currently remain `unknown`. Exit 0 is
reserved for all checks passing; either a failure or an unknown check produces
exit 1. Inspect `failures` and `unverified` separately. This command is therefore
not yet a complete readiness or acceptance check. The privacy-only mode retains
its metadata-only behavior and separate exit criteria.


The profile password and Matrix key must have mode `0400`, matching the service's
unlock-file reader. The four bridge databases' `-wal`, `-shm` and `-journal`
sidecars are checked when present; their absence is normal. Unsafe existing
sidecars fail the permissions check. The `profiles`, `bridge` and `runtime`
parent directories must also be private and owned. These checks remain metadata
observations, not database unlock or encryption verification.


## Bridge database access

The operational mode now reads the configured Matrix store key after private
metadata checks and derives keys using the same function as service startup.
It opens the four bridge databases read-only with zero busy timeout and reads
schema metadata only. It does not invoke store constructors, run migrations or
read message rows. Key buffers are wiped afterward. SQLite may use its normal
WAL/shared-memory coordination while reading an active database.

A pass establishes that these bridge schemas can be read with the configured
key and identity. It does not certify every page, schema-version compatibility,
or access to native Matrix crypto or upstream Threema stores. Missing/unsafe
metadata skips the check; key errors, unreadable schemas, corruption or contention
fail it without printing raw SQLCipher errors. Privacy-only mode does not read
keys or open any databases.

## Local registration and proxy configuration

Operational doctor now checks the appservice registration against configured
listener, namespace and routing requirements. With a managed proxy, it also
validates the explicitly configured credential file, matching proxy registration
and executable checksum using the same preparation path as startup. It never
starts the supervisor, invokes bbctl, discovers personal account files or sends
requests. Unsafe file metadata skips these checks; malformed or mismatched
configuration fails with fixed messages that exclude tokens and source snippets.

These passes establish local configuration consistency only. They do not prove
that remote registration exists, credentials are accepted by Beeper, or the proxy
is connected. Those remain distinct unverified checks. Privacy-only mode continues
to avoid credential-file contents.
