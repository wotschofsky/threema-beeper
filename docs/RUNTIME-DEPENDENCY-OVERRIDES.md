# Pinned runtime dependency overrides

Linux staging replaces the Matrix framework's js-yaml resolution with the exact
`4.3.2` installation under `native/runtime-dependencies`. The package manifest and
npm lockfile pin the release and archive integrity. Install it with:

```sh
pnpm --dir native/runtime-dependencies install --frozen-lockfile --ignore-scripts
```

The framework declares the compatible `^4.1.1` range, but the development checkout
has 4.3.1. The upstream [js-yaml advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)
identifies 4.3.2 as fixing accounting for empty merge sources. This packaging
override leaves the running development checkout unchanged. The staging dependency
graph and relative links resolve the framework to the pinned installation and its
dependency closure. This is not a blanket override for unrelated js-yaml consumers.

`tests/entry.yaml-runtime.ts` checks configuration/registration round-trips,
ordinary merges and a small fixture with an explicit merge budget. Image inspection
requires the actual Matrix framework resolution to be 4.3.2. Candidate images must
pass the package suite and a fresh inventory/scan before the finding is considered
remediated in shipped artifacts. Source and installed-version changes alone do not
update any already-built image or live service.

Both rebuilt candidates now pass native inspection, including actual Matrix
resolution, all 53 selected package tests and all 13 codec checks. Their inventories
contain only js-yaml 4.3.2, and scans against the refreshed database no longer
report `GHSA-2883-xcg3-v3hh`. Each scan has 175 remaining matches, including one
critical and 68 high; no suppressions were added. Current image/context identities
and test/log hashes are in `NODE-CLEANUP-BUILD.json`, inventories/scans in
`NODE-CLEANUP-IMAGE-REVIEW.json`. Live development and exported release images
remain unchanged. This closes that finding for the candidate artifacts only.

## CIDR/IP parser candidate

The Matrix framework uses `ip-cidr` for provisioning range construction and
membership checks. Its installed ip-cidr 3.1.0 depends on ip-address 7.1.0;
the upstream [IP parser advisory](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-mwp4-54f8-5fhr)
identifies 10.3.1 as the fixed release. The isolated dependency lock now pins
ip-cidr 4.0.2 with ip-address 10.3.1. This deliberately crosses the framework's
declared ip-cidr major range and requires compatibility verification.

A direct upgrade failed because ip-cidr 4 calls the old bigint method names.
`scripts/runtime-dependency-overrides.ts` adapts six call sites to `bigInt` and
`fromBigInt` during staging. It verifies the full input/output source hashes and
rejects unexpected source changes; it does not modify the installed package or
the live framework checkout. The original library license files remain included.

Tests cover IPv4/IPv6 boundaries, individual hosts, mapped IPv4, bigint conversion,
bounded enumeration, ordinary YAML configuration and rejection of ambiguous IPv4
notation. Image inspection additionally checks actual framework resolution and
constructs a CIDR through the CommonJS/ESM import path used by the framework.
Source tests and TypeScript pass. Both image builds now pass native inspection,
55 package checks and 13 codec checks. Inventories contain only ip-address 10.3.1,
adapted ip-cidr 4.0.2 and js-yaml 4.3.2. Both parser advisories are absent from the
new scans, which retain 173 unsuppressed matches each (one critical and 67 high).
Exact image identities, context and evidence hashes are in `NODE-CLEANUP-BUILD.json`
and `NODE-CLEANUP-IMAGE-REVIEW.json`. Existing exports and the live bridge remain
unchanged. This is a parser/library fix, not a
claim that all network filtering or provisioning behavior is fully reviewed.
