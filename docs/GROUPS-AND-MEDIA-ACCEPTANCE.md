# Personal groups and media acceptance — 2026-09-15

Existing groups, photos/files, video and voice/audio were enabled on the Mac. The normal launcher now supports `bridge.features.groups` and `bridge.features.media` independently; both default to false for existing installations. Both are enabled in the Mac configuration. Reactions, edits/deletions, typing, receipts, calls, polls and locations remain outside this assembly.

## Observed live results

- Existing linked profile reopened without relinking. Four retained group messages were imported. One active group is writable, has its own JPEG/PNG avatar, and includes the owner plus other members.
- The duplicate owner ghost was removed from group membership. The bridge bot stays joined for encryption/routing but its membership uses `com.beeper.bridge.is_bridge_bot`. Existing cached entries required an unmarked leave followed by **both a marked invite and marked join**; an unmarked invite leaves a visible pending bot entry. This affects Matrix membership only, never Threema group membership.
- Four Beeper-originated attachment requests are SENT with their native echoes observed: a 42-byte text file, PNG, short H.264/AAC video, and a one-second generated voice-note source. ECHOECHO returned all four; Beeper displays one peer attachment for each, including audio/mp4 for the voice note. Native history has matching incoming/outgoing attachment types. Inbound journal pending count is zero.
- Restarts during verification preserve mappings and completed media sends. No automated messages were sent to real contacts or groups.

## Integration fixes

- Beeper's matching top-level URL and encrypted file URL are accepted; conflicting/plaintext locations remain rejected.
- Downloads use appservice credentials and allow one signed HTTPS redirect only from the Beeper Hungryserv endpoint to its validated R2 media host pattern. The Matrix token is never forwarded. Failed response body destruction is handled without crashing Node.
- Native prepared file/image/video calls retain their worker-local controller receiver with `Reflect.apply`, preserving the durable ID allocation barrier.
- MP4 audio and video share a container signature; libmagic's generic video/mp4 result does not reject audio/mp4.
- Darwin uses a process supervisor that samples codec physical footprint every 10 ms, with CPU/file limits and process-group cancellation. This is not Linux's allocation-time address-space limit or a filesystem/network sandbox.
- The Mac configuration uses installed FFmpeg with `avc_encoder: libx264`. Linux's default remains `libopenh264`. Image and audio/video helpers have explicit absolute paths under `bridge.media.tools`.

The first file attempt was rejected before dispatch because of the URL duplication. The next attempt exposed the controller binding failure before allocating IDs; its single ECHO-only request was recovered under exact identity/filename/no-allocation guards after backing up stopped encrypted stores. The rejected test remains in history; it is not counted as successful. No general uncertain-send auto-retry was added.

## Checks

- `pnpm run test:personal-import`: 49 passing tests.
- `pnpm run test:personal-media`: 36 passing tests.
- Five video preparation tests pass through the actual Darwin limiter with `VIDEO_TEST_AVC_ENCODER=libx264`, including VP9 conversion, multitrack metadata and cancellation. Image/audio preparation also passed through the actual limiter.
- Root and headless TypeScript checks pass.

## Remaining acceptance

Live outbound groups are not tested because authorization permits automated messages only to ECHOECHO. Group management, former-member history, every image/container variant, large files, media replies, long outages, revocation, fresh installs and portable releases still require work. Photos/files/video/audio round trips are evidence for the tested fixtures, not all codecs or extended daily reliability. See the root plain-language limitations for the wider deferred scope.
