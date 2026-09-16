# Contact and group metadata

`BackendController.directory()` returns a validated plain-data snapshot of contacts and groups.
The headless adapter reads upstream model repositories and calls the existing privacy controller's
`isContactBlocked` policy, including implicit blocking. It does not duplicate that policy or infer
blocking from a display name. Contact records contain identity, names, verification, activity and
blocked state. Public keys and controllers are excluded.

Groups retain creator identity, bigint group ID, canonical group key, name, user state and complete
member identities. The upstream ordinary member set excludes both creator and local user, so the
adapter adds the external creator and includes the local user only while their state is MEMBER.
Membership is deduplicated and sorted. Worker validation checks fixed-width IDs, key/ID consistency,
known state values, duplicates, extra fields and aggregate size limits. Privacy-setting updates now
invalidate profile reconciliation alongside contact/group changes.

`pnpm run test:directory` runs synthetic models through the bundled adapter and boundary validator.
It covers blocking-policy delegation, self/external creator groups, left-group membership and
private-field rejection. Topology tests cover privacy changes. No real directory was read.

This is a bounded-output full snapshot. The profile coordinator now persists it with staged messages
in the encrypted journal under one completed epoch. Paging, avatar references and Matrix metadata
application remain pending. State values currently use the pinned upstream enum values; future
schema changes must be explicitly supported.
