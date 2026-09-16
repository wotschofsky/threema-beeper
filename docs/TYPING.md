# Typing indicators

Outgoing contact typing is wired from freshly accepted, authenticated Matrix transactions to
the native conversation controller. The HTTP callback uses the pinned SDK's
`de.sorunome.msc2409.ephemeral` extension. Duplicate transactions and durable replay do not feed
typing back into the runtime. Raw accepted transaction storage can contain typing EDUs.

TypingRuntime accepts the configured owner's presence in a room typing list for an existing
owned contact portal. Fresh DispatchGuard authorization checks encrypted room state and owner
membership before delivery. It bounds desired state to 128 rooms, coalesces updates, refreshes
at most once every two seconds and expires input after fifteen seconds. Superseded updates are
discarded after asynchronous authorization. Failed updates are dropped rather than retried.

The worker's `watch-connection` stream subscribes to native ConnectionManager.state. Only
CONNECTED enables typing. Disconnect notifications clear pending state immediately, including
brief disconnect/reconnect transitions between scheduler polls. Stream loss reports disconnected.
Startup installs the subscription before starting processing; shutdown clears typing and closes
the subscription. Native dispatch additionally checks connection state before conversation lookup
and immediately before invoking the controller.

`setTyping({profile, chatId, typing})` uses an exact-field parser, verifies the active identity,
resolves an existing conversation, and calls `conversation.controller.updateTyping.fromLocal`.
Pinned Desktop applies contact-specific or global privacy policy, coalesces outgoing starts and
expires outgoing typing after five seconds without refresh. Its incoming indicator expires after
fifteen seconds. Group outgoing typing is unsupported by that controller and rejected by the adapter.

Offline evidence: rebuilt headless bundle; root and headless TypeScript checks; native adapter
forwarding/connection rejection, runtime coalescing/expiry/recovery, authenticated acceptance,
connection-stream ordering/loss and service scheduler readiness tests. Native adapter tests use
synthetic controllers; they do not prove live protocol behavior.

The native incoming `watchNodeTyping` contact subscription now observes conversation isTyping
through upstream stores, deduplicates changes, clears on disconnect/removal, and suppresses
cached true after reconnect. Session/controller `watchTyping` exposes it over a boolean IPC
stream; stream closure reports false. An offline regression uses actual upstream writable/set
stores to exercise these transitions.

IncomingTyping now reconciles contact subscriptions from synchronized metadata and projects
state through existing Matrix ghost intents. DispatchGuard verifies the owned encrypted portal
before each request; readiness, mapping and update version are rechecked after authorization.
Matrix indicators expire after ten seconds and active native state refreshes every five seconds.
Disconnect clears pending state. Shutdown releases subscriptions; Matrix timeout clears any
remaining indicator. Runtime regressions cover refresh/stop, disconnect, cleanup and a stale
update invalidated during authorization. Service scheduler regression now verifies incoming true/false through the configured ghost
client, owned-room authorization and ten-second Matrix timeout, alongside outgoing typing and
subscription cleanup. Native source and Matrix transport are synthetic in this test. No live
account has been exercised.

Remaining: subscription recovery/scale, native privacy/timer tests
through actual controller behavior, and live typing acceptance. Native in-flight task/repeat
behavior during a disconnect still needs verification. No live typing has been sent.

Delivery accounting now distinguishes a skipped stale update from an actual Matrix request;
skipped sends do not advance the last-delivered typing state.
