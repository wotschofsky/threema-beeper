# Reconciliation performance

The bridge synchronizer now stages a bounded history page in one durable transaction, instead of committing every snapshot message separately. The existing 500-row page bound, per-chat staging quota, encrypted storage, snapshot/live ordering and atomic profile publication remain enforced. A rejected row rolls back its entire page. Unpublished snapshots remain unavailable for delivery.

## Measured on 2026-09-15

`pnpm run benchmark:reconciliation` creates 100,000 synthetic text messages across 100 conversations, generates only one requested page at a time, and runs the production `ProfileSynchronizer` and SQLCipher `MessageJournal`. It checks every stored message against the generated fixture, closes/reopens the journal, reconciles again, and asserts that replay adds no duplicate pending changes. Temporary data and keys are discarded afterward. No account or network is used.

| Implementation | Cold reconciliation | Reopened reconciliation | Lifetime peak RSS after both |
|---|---:|---:|---:|
| Per-message commits | 45.0 s | 44.1 s | 182.2 MiB |
| Per-page commits | 12.0 s | 10.0 s | 233.0 MiB |

These are single runs on the macOS ARM64 development machine with Node 24.13.1 and `--max-old-space-size=256`. The latter bounds the JavaScript heap, not total native process memory. Faster batching had higher observed RSS; no memory reduction is claimed. The generated encrypted database was approximately 168.5 MiB. Timings exclude row-by-row verification after reconciliation. Machine-readable measurements and benchmark hash are in `RECONCILIATION-BENCHMARK.json`.

The focused 11-test journal/synchronization suite passed, including page rollback, reopen, invalid page size, gating, interrupted reconciliation and cross-chat live ordering. TypeScript checks passed.

## Remaining performance acceptance

This establishes the encrypted bridge reconciliation portion of the 100,000-message target. It does not establish full linked-device startup, Matrix backlog delivery, p99 network latency, 24-hour offline recovery, or target-host performance. The native reader now uses the bounded window described below, but upstream still loads the full conversation model set and the adapter scans it for each page. Those costs are excluded by the synthetic source and remain part of full-profile acceptance. Target-host deployment needs its own measurements.

The performance-build Linux images included this optimization; their measurements and immutable IDs are recorded below. Newer monitoring/validation images also retain the optimization, but these timings belong to the measured predecessors. The earlier macOS measurements remain source-level observations.

## Native page-selection memory

The headless history reader now scans upstream's iterable model set into a max-heap holding at most `limit + 1` candidates (at most 501). It sorts only that window; the extra candidate determines whether to return a continuation cursor. Selection adds O(page size) retained references and O(N log(page size)) work per page, replacing the extra O(N) candidate array and full sort. The upstream model set itself is still retained, and every page still scans it. This does not prove bounded total native-model memory or optimal whole-history traversal.

The rebuilt native adapter passed a 100,000-model selection test against a full-sort reference, including tied ordinals and high-bit IDs. Existing cursor-removal, empty/missing-chat and validation cases passed. The standalone window selector also matched full sorting for ascending, descending and permuted 100,000-row input at capacities 1, 2, 100 and 501. All 12 focused history/synchronization tests passed; root and headless TypeScript checks passed.

These tests use synthetic model stores with the actual bundled reader and normalizer. They do not open a real large Threema profile. The current exported Linux images contain both performance changes and passed the package checks described in `DEPLOYMENT-ADDITIONS-ACCEPTANCE.md`.

## Packaged Linux measurements

| Architecture | Cold | Reopened | Lifetime peak RSS |
|---|---:|---:|---:|
| amd64 | 17.6 s | 19.7 s | 182.9 MiB |
| arm64 | 13.4 s | 11.8 s | 154.9 MiB |

Both packages verified every synthetic message and retained exactly 100,000 pending changes after replay. The harness was mounted read-only, while synchronizer and encrypted journal modules came from the image. These runs used a 768 MiB tmpfs, no networking, UID 1000, a read-only root and disabled core dumps. ARM64 ran in the native Docker Linux VM and AMD64 under emulation. They are single runs with shared host load; tmpfs is not a persistent production disk and cannot establish power-loss durability or target-host startup times. Image IDs and build context are bound to the measurements in the JSON record.

## Separate-process restart measurements

The benchmark now starts a fresh child process for each round. The first reconciles
an empty encrypted journal; the second reopens that same journal and reconciles
again. Both check every stored message and require exactly 100,000 pending changes.
The parent checks successful child exits and different process IDs before reporting
success, then removes the private synthetic database and key. The 256 MiB heap
limit is inherited by both children.

Peak RSS now belongs to each round independently, including that child's row
verification, rather than carrying over the first round's peak. Reconciliation
duration still excludes the subsequent row-by-row verification. “Cold” means an
empty bridge journal; it does not mean the OS page cache was cleared.

The new Linux measurements use a disk-backed private host directory mounted into
the container, rather than a tmpfs database. Each container has a 768 MiB memory
limit with no additional swap allowance, networking disabled, read-only root,
dropped capabilities and core dumps disabled. The benchmark script is mounted
read-only; production modules come from the migration images. Architectures run
sequentially. These are single runs on a shared development host, not repeated
statistical measurements or target-host tests.

Results and exact image/script/log identities are in
[separate-process benchmark evidence](RECONCILIATION-PROCESS-BENCHMARK.json).
Native model loading, Matrix delivery, 24-hour offline backlog and full target-host
startup acceptance remain open.
