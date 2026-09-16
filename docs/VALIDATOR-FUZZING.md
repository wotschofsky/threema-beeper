# Seeded validator fuzzing

`pnpm run test:validator-fuzz` exercises six boundaries: history pages, history requests, directories, conversation lists, stored-message decoding and stored-metadata decoding. It uses synthetic fixtures and a deterministic xorshift generator; no account, network, database or real messages are accessed.

The generator combines malformed nested plain objects, arrays, non-finite/unsafe numbers, invalid dates, bigint values, control characters and schema-key mutations. Stored JSON is separately mutated at a generated character offset. Valid fixtures are interspersed so the test does not pass by rejecting everything. Accepted values must survive another validation or codec round trip unchanged. Rejections must be Error objects; unexpected TypeError or RangeError fails the campaign. Tests never print generated message content.

Reproduce the expanded run:

```sh
FUZZ_SEED=89abcdef FUZZ_ITERATIONS=100000 pnpm run test:validator-fuzz
```

The seed is one to eight nonzero hexadecimal digits. Iterations are bounded to 5,000–1,000,000, with six calls per iteration, a 60-second test deadline and a 256 MiB JavaScript heap limit. The default seed is `5eed2026`, with 5,000 iterations. Heap limits do not bound all native process memory. This is deterministic mutation testing, not coverage-guided native fuzzing; a finite passing seed is not proof that every malformed input is safe.

## Evidence on 2026-09-15

The 100,000-iteration run completed in approximately 3.5 seconds on the development Mac: 600,000 calls, 77,648 accepted and round-tripped, 522,352 rejected. Both the campaign and aggregate-size regression passed. Ten adjacent history/metadata/synchronization tests and TypeScript checks also passed.

The accompanying boundary test exposed a missing aggregate limit in conversation validation. Individual names were limited, but a list could contain more than 16 MiB of text. `parseConversations` now counts UTF-8 bytes for names, chat IDs and optional last-message IDs, and rejects the list above 16 MiB. The regression uses multibyte names that individually satisfy the character limit, while their combined byte size exceeds the budget. Validation can bound further processing/output; the caller must still bound transport allocation before invoking the parser.

## Remaining security acceptance

Coverage-guided fuzzing of setup/admin HTTP handlers, native codecs/transcoders, arbitrary stored-record corruption and larger decompression/media fixtures remains open. Dependency vulnerability scanning, compiled-dependency inventory completion and the full release security review are separate requirements. The current exported Linux images include this parser change and the heartbeat addition. Both architectures passed the default 30,000-call campaign and HTTP boundary tests as part of their 28-test package suite; the expanded 600,000-call run above was on the development host.

## Authenticated HTTP boundary checks

The real loopback appservice test now sends 128 malformed/oversized events, an excessively nested transaction, and malformed recovery actions. It verifies HTTP 400/413 responses with fixed error bodies, an empty encrypted inbox and no transient callback execution before sending a valid control transaction. Existing unauthorized, chunked-body size, conflict, retry, reopen and unavailable-database cases remain covered.

This exposed recovery-action coercion: `{"action":["retry"]}` received HTTP 200 because `String(body.action)` passed the allowed-value check. The server now requires a literal string, and arrays/objects/null/numbers/booleans receive HTTP 400 without reaching the recovery callback. Valid `retry` and `resync` strings remain accepted. The regression reproduced HTTP 200 before the fix and passed afterward.

Run `node tests/entry.transaction-server.ts` with permission to listen on loopback. It uses a temporary encrypted inbox and synthetic requests, not the daily account. This extends HTTP boundary coverage; it is not a concurrency/slow-client load test or coverage-guided fuzzing of every setup route.
