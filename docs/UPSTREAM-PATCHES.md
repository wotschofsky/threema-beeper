
## Native tracker membership failure propagation

The existing `matrix-overlay/e2ee/CryptoClient.ts` overlay now propagates `getRoomMembers`
failures while handling `m.room.encryption`, replacing the upstream warning-and-success path.
The appservice decoder must keep the transaction pending if recipient tracking failed.
This changes error handling only; crypto algorithms and membership-selection semantics remain
upstream. Native session state-failure/retry and two-device exchange regressions pass. The
SDK version/original fingerprint remain in the existing source manifest. Not submitted upstream.
