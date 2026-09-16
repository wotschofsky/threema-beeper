# Account-status forwarding for the bridge

The pinned bbctl proxy always sends `UNCONFIGURED` when it connects. It cannot report the
linked Threema account through its stock proxy mode. This opt-in patch adds `--bridge-status`:

- Read `GET /_threema/bridge-state` from the existing loopback appservice URL with its hs_token.
- Forward global and account states using the upstream `bridge_status` WebSocket command.
- Refresh every 30 seconds and on reconnect; the local response expires after 90 seconds.
- Reject redirects, non-loopback status URLs, malformed states and excessive lifetimes.
- Keep the original behavior unless the flag is supplied. Do not log account identities or tokens.

The service reports account `CONNECTED` only while live, ready and synchronized. This reports
connection health, not proof that messages have been delivered.

Source: `https://github.com/beeper/bridge-manager`, commit
`621b50c3c9e395eda28ebe522a1406fdef71c8c9` (mautrix/go v0.29.0).
The patch retains reconnect and keepalive behavior. If local transaction delivery fails, it closes the socket before responding so Beeper can replay the unacknowledged transaction. The real WebSocket regression test covers this ordering.
It does not change the separately pinned release binaries or their checksums.

To reproduce from the project root, with Go 1.27.1 available:

```sh
pnpm run prepare:status-proxy
```

This builds both Linux architectures from a clean pinned source archive without
changing the running Mac proxy or its checkout. It applies the account-status
patch and the dependency update below, then runs the status/spool tests. Linux
staging verifies the source patch, dependency pins and per-architecture SHA-256
manifest. The generated executables are local and ignored by Git; exported
release artifacts do not change until rebuilt and verified separately.

## Pinned dependency update

`dependencies.patch` updates golang.org/x/crypto to v0.56.0, x/text to v0.41.0 and
the module's Go minimum to 1.26.0. `dependencies.json` records the compiler version,
module versions, patch hash and original/patched go.mod/go.sum hashes. Builds use
Go 1.27.1, disable workspace overrides and use readonly module resolution.
The selected crypto version includes the fixes identified in the official
[GO-2026-6303](https://pkg.go.dev/vuln/GO-2026-6303),
[GO-2026-6354](https://pkg.go.dev/vuln/GO-2026-6354) and
[GO-2026-6355](https://pkg.go.dev/vuln/GO-2026-6355) reports.

The build requires pass events for all four named status/spool regression tests
from uncached Go JSON output. The manifest records that report hash and the exact
dependency pins. Both Linux binaries built successfully, all four tests passed,
and `go version -m` confirms the pinned crypto/text versions in each executable.
Both current Linux candidate images now include these binaries. Each passes 55
package checks and 13 codec checks; fresh inventories confirm the pinned modules
and scans no longer report the three advisories. See
`docs/NODE-CLEANUP-IMAGE-REVIEW.json` for image-bound evidence and remaining
release limitations. Live services and exported releases remain unchanged.


## Durable transaction queue

Production also uses `--transaction-spool <private-directory>`. Transactions are AES-256-GCM encrypted using a domain-separated key derived from the appservice token, atomically published and fsynced before acknowledgement. A single locked worker forwards them to the local durable inbox and removes them only after a successful HTTP response. Failed/local-lost responses retry with a stable payload-derived transaction ID. This also avoids collisions when Beeper reuses a transaction range ID after removing expired payloads.

The queue is bounded to 10,000 transactions / 1 GiB; individual payloads are bounded to 50 MiB. Keep its directory under the bridge profile state so stopped-service backups include it. Preserve the appservice registration/token with the queue. Wrong keys or corrupted entries fail closed and require recovery; they are not silently discarded. Payloads already accepted by this queue survive process restarts and extended local-service outages. Messages never received from Beeper still depend on Beeper's retention; full-host/network outages need target-host acceptance.

The Mac currently uses `.local/bin/bbctl-status/bbctl-spool`. Build it from the patched checkout with `go build -o ../../bin/bbctl-status/bbctl-spool ./cmd/bbctl`. Linux builds are produced by `pnpm run prepare:status-proxy` from a clean pinned archive and verified patch. Regression tests cover real WebSocket acknowledgement ordering, private encrypted persistence, exclusive ownership, lost local responses, restart, wrong keys and corruption.
