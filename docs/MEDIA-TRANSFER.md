# Attachment transfer implementation

`prepareAttachment` consumes a bounded Node Readable and writes only encrypted bytes into a private
ciphertext spool. It checks declared size, configured limit (at most 1 GiB), expected SHA-256 and an
injected content-sniffing policy. The policy gets at most 4096 header bytes. Source chunks above 1 MiB
are rejected; the spool upload reader uses 64 KiB chunks. Backpressure flows through Node pipeline.
No entire production attachment is buffered or base64-encoded. Protocol keys, IVs and hashes use the
encodings required by Matrix.

The SDK's native encryptMedia method takes a complete Buffer, so it cannot satisfy handoff §14's
streaming requirement. The streaming adapter instead uses Node's standard AES-256-CTR primitive,
with independent random keys and IV prefixes, zero-initialized 64-bit counters and a ciphertext
SHA-256. This follows [Matrix encrypted attachment v2](https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments).
The 1 GiB bound is far below the counter's wrap limit. Interoperability is checked with the pinned
native Attachment.decrypt, including ciphertext tampering rejection.

Only after validation completes does `uploadAttachment` open a ciphertext stream and pass it through
the SDK's authenticated HTTP path. Upload metadata is application/octet-stream without a plaintext
filename. The SDK HTTP overlay recognizes Node Readable bodies, preserves streaming and logs only a
stream marker at trace level. It no longer JSON-serializes the stream. The returned encrypted-file
metadata belongs inside the encrypted room event and protected persistence; never expose its key
through room state or logs. The caller must dispose the prepared spool in a finally block after
persisting what recovery needs. Cancellation destroys the upload stream.

`test:encrypted-attachment` uses chunked input, actual streaming encryption and the native decryptor.
The upload test intercepts the SDK's low-level request function and checks the body is still a
Readable with byte-identical ciphertext and authenticated octet-stream metadata. It also checks
bounds/hash/MIME rejection, abort cleanup and refusal to reopen disposed spools. Test-only buffers
collect ciphertext for assertions; the implementation does not collect whole files.

Remaining integration: authenticated Threema MediaRef streams and expected hashes, a concrete MIME
sniffer, lower-of-Matrix/Threema limit discovery, source download retention, durable upload metadata
and retry/cancellation state, crash-orphan cleanup under exclusive profile ownership, quota control,
message/thumbnail rendering, outbound media and live Beeper upload compatibility. A lost upload
response may leave an orphan remote ciphertext object; no exactly-once media upload is claimed.
The journal still leaves media rows pending until this complete path is wired.

## Durable upload recovery

MediaTransfer now saves a schema 8 SQLCipher upload record before its first HTTP request, containing
the content fingerprint, ciphertext spool identifier and Matrix attachment key/IV/hash. The scope
must identify the owning profile/account; callers must use a stable operation ID. Conflicting ID
reuse fails. Retrying a pending upload reopens the private regular file, checks size and ciphertext
hash, and uploads the same bytes with the same key. No source read or encryption is repeated.

Successful upload URI/key metadata is committed before spool disposal. After restart, completed
operations return that result without network access and retry any interrupted spool cleanup.
Concurrent calls on one MediaTransfer share a request when their fingerprints match. The caller
still needs exclusive profile ownership. If a pending spool directory or ciphertext file is missing,
recovery reopens the authoritative source and verifies size, plaintext SHA-256 and MIME again. It
creates fresh encryption material and atomically replaces only the observed unfinished SQLCipher
record before uploading. A changed/unavailable source leaves the old record pending. Completed
records cannot be replaced. Corruption, unsafe permissions, symlinks and malformed descriptors still
fail without uploading. Startup cleanup removes orphan spools, including files left before preparation commit (see below).

`test:media-transfer` checks lost upload response, restart, identical ciphertext/key reuse, cached
completion, conflicting scope, corrupted-spool rejection, missing-file/directory recovery across
restart, changed-source rejection and completed-record protection. Matrix uploads do not have event-style
transaction IDs: a lost response may leave an extra ciphertext object on the server. Durable event
sending begins only after an accepted URI is saved, so the upload ambiguity need not duplicate room
messages. Journal integration, source streaming and metadata rendering are still incomplete.

## Media event rendering

MediaRenderer now handles image/video/audio/file canonical content. It obtains verified source
metadata through an injected describe/open interface, checks it against canonical size/MIME,
asks for the configured upload limit, and uses MediaTransfer for both main content and thumbnails.
Upload IDs derive from profile/chat/message/part/hash/MIME, so caption edits reuse accepted media.
The thumbnail has its own descriptor and encryption key. Failed thumbnail upload leaves the message
pending while a successful main upload remains reusable.

Rendered Matrix content uses m.image/m.video/m.audio/m.file with encrypted `file` and
`info.thumbnail_file`, preserving filename, caption, size, MIME, dimensions and millisecond duration.
It never uses a plaintext media URL. MessageDelivery now accepts this renderer, applies the same
durable projection, reply and edit mapping machinery as text, and records all media edit event IDs
for later deletion. MatrixJournalSink accepts the renderer and permits media when it is supplied;
without it, media remains pending.

`test:media-renderer` verifies four media kinds, video dimensions/duration, caption/filename,
independent thumbnail encryption and caption-edit reuse with actual streaming preparation and
protected upload caching. Network and MIME sniffing are synthetic, while event sending is stubbed
at its separately tested durable boundary. This does not yet provide live core MediaRef access.
The source adapter must return expected hashes and bounded streams, implement MIME sniffing and
choose the lower upstream/Matrix size limit before enabling the renderer in a running service.

## Authenticated upstream local file stream

The Desktop overlay now exposes worker-local openNodeStoredFile and describeNodeStoredFile. They
reuse the pinned upstream FILE_STORAGE_FORMAT, chunk sizes and FileChunkNonce, decrypting each
AES-GCM chunk with Node WebCrypto before yielding it. The file handle/key remain private to the
worker API. The reader rejects unsupported format versions, invalid IDs, size limits, symlink files,
truncation, extra ciphertext and authentication failures, and closes its descriptor on completion,
error or cancellation. It keeps bounded chunks rather than allocating the complete plaintext.

The descriptor helper authenticates and hashes the full local file first. A later stream pass can
feed Matrix attachment preparation, which checks that expected hash again before upload. This
uses the upstream immutable-file property and reads local ciphertext twice. Hashing itself does
not export a key or filesystem path.

`test:file-stream` creates real files with the upstream FileSystemFileStorage writer in the built
headless bundle, then reads them through the adapter at zero/one/exact-chunk/multiple-chunk sizes.
It tests ciphertext corruption, trailing bytes, format/size limits and cancellation. The backend
bundle builds with the added module. Model-to-file lookup, initiating upstream download/cache when
fileData is absent, worker stream IPC and MIME detection remain to be wired. Upstream's existing
blob() and load() helpers return whole buffers and cannot replace this stream API in the bridge.

## Worker byte-stream protocol

`serveByteStream` and `receiveByteStream` provide the media MessagePort transport. Node demand sends
one numbered pull credit; the worker transfers at most 64 KiB in response. Both ends enforce the
expected byte count, sequencing and configurable timeout. The parent maintains a 64 KiB high-water
mark; the worker reads only available bounded bytes, avoiding Node's async-iterator chunk coalescing
and avoiding waits for a full packet at a short final chunk.

Cancellation/port loss closes the source, and the server completion promise waits for source
closure. Source diagnostics become a fixed protocol error, so local paths or key-containing errors
are not copied into the parent. The protocol contains only control fields and media bytes. Callers
must own and authenticate the control request which creates the channel.

`test:byte-stream` covers lazy consumption, slow-reader backpressure, byte integrity, size mismatch,
source errors, cancellation, timeouts and malformed peer packets. `test:file-stream` now also
passes authentic upstream encrypted files through this channel before checking their plaintext
hashes, covering empty/one-byte/exact/multiple-chunk cases. Registering the stream command in the
backend worker/controller and resolving canonical media messages to stored handles remain pending.

## Canonical media lookup in the backend session

The session now captures its real FileSystemFileStorage instance through the factory and exposes
worker-local `media(request, signal)`. The request contains chat/message IDs, file/thumbnail selection
and a byte limit. The resolver finds the exact conversation and message, decodes the full 64-bit
little-endian ID with upstream helpers, checks the media type and canonical file size, and hashes the
retained encrypted file through the authenticated stream reader. Its result exposes only size,
SHA-256, MIME and a worker-local stream-opening closure. File keys and paths remain captured inside
that closure.

Missing retained data returns MEDIA_NOT_CACHED, not MEDIA_EXPIRED: no remote availability has been
checked. The upstream download/cache path is still pending, and the worker control protocol must
register metadata/stream commands before the renderer can use this source across threads.
Tests combine synthetic model references with real upstream encrypted files, including maximum u64
message-ID decoding, metadata mismatch, missing thumbnail, unsupported/deleted message and wrong
conversation. The session/factory changes pass focused lint and headless typechecking; the bundle
now includes 781 modules.

## Registered worker media commands

The backend worker/controller now expose mediaInfo and mediaStream. Metadata is explicitly whitelisted
as byte size, SHA-256 and MIME; stream opening is a separate request carrying expected metadata and
a MessagePort. The worker resolves/authenticates the retained source again and rejects changed
content before sending bytes. A shared four-operation limit covers active hashing and streams;
stream slots release only after source closure. Parent cancellation closes the port and aborts the
worker-side operation. Media-info cancellation currently requires stopping the worker or awaiting
its bounded hash pass.

`describeBackendMedia` supplies MediaRenderer's lazy describe/open contract, so cached upload reuse
does not open an unused stream. It still hashes the retained file when describing it. Known media
failure categories are whitelisted over the control channel; arbitrary upstream diagnostics stay
scrubbed. Tests verify metadata whitelisting, changed-source rejection, deferred stream opening,
byte transport and the operation limit. A linked live profile is still required to validate these
registered commands against actual conversations. Automatic upstream download/cache and the
concrete MIME policy remain unfinished.

## Concrete MIME policy and backend renderer factory

MimePolicy invokes the absolute configured file(1) executable with libmagic, passes only the bounded
header on stdin, and compares the detected MIME with the claim. It accepts exact matches and a small
set of spelling aliases; application/octet-stream intentionally claims only generic binary content.
Other mismatches fail as MEDIA_MIME_MISMATCH. Detector failure fails closed with a fixed error, and
process duration/output are bounded. No filenames are passed and no shell is used. Header detection
is not complete file validation or malware scanning. Ambiguous/truncated headers may be rejected;
container-specific refinements still need broader fixtures.

createBackendMediaRenderer now assembles the controller metadata/stream adapter, SQLCipher transfer
recovery and this real policy. It enables the bot's crypto before capturing its active SDK client.
Pass its render method to MatrixJournalSink. The configured maximum must already be the lower
Matrix/Threema limit; automatic discovery remains unfinished. Runtime images need file(1)/magic data
included and recorded in deployment dependencies/SBOM. Local validation used file 5.41.

Tests cover PNG/PDF/text detection, MIME mismatches, script content claiming to be an image, detector
failure and bounded input. The factory test uses a synthetic backend byte source with actual MIME
checking/stream encryption, proves cached renders do not reopen it, and rejects a mismatch before
upload. Automatic uncached-media download and live end-to-end profile validation remain pending.

## Discovered upload limits

UploadLimits now queries Matrix media config through the authenticated SDK, using the v1.11 media
endpoint when advertised and the legacy media endpoint otherwise. It combines the advertised limit,
the configured local cap and the limit exported from the actual pinned Desktop bundle. The current
pinned build defines MAX_FILE_MESSAGE_BYTES as 100 MiB. No duplicated production constant is used:
BackendController.mediaLimits reads the worker's compiled upstream value.

Limits are cached for 60 seconds, with concurrent requests sharing discovery. Refresh failure does
not reuse expired data. Invalid negative/noninteger server values fail, zero disables uploads, and
an omitted advertised limit still leaves the local and Threema caps enforced. MediaRenderer rejects
oversized messages before asking the backend to hash/open them. createBackendMediaRenderer uses this
discovery automatically; its maximumBytes option is now the additional local cap.

Tests cover minimum selection, both Matrix endpoint generations, omitted/zero/invalid limits,
concurrent discovery, cache expiry and outages. A real dedicated worker test verifies the upstream
100 MiB result and rejects media requests before a profile is open, closing transferred ports.
Live Beeper media-config compatibility and automatic upstream downloads still need validation.

## Upstream cache population

A fingerprint-checked Desktop runtime patch adds ensureCached(file/thumbnail) to media controllers.
It invokes the existing blob/thumbnail loader and returns void rather than returning full media over
the model proxy. The resolver uses it when local FileData is absent, then rereads the model and
streams the resulting encrypted local file. Known canonical size is checked before download.
Cached data bypasses the loader. A deletion/type change during download fails instead of using stale
metadata. Audio thumbnail requests are unsupported.

The blob loader still performs upstream's existing buffered download/decryption internally. This
patch removes the extra proxy transfer, not that internal memory use. Cancellation is checked before
resolution and after cache population; cancelling an individual in-flight upstream download still
needs a core API change. Network streaming/memory profiling therefore remain incomplete against the
full handoff. Download errors currently stay pending rather than becoming a definitive expired-media
notice without confirmed upstream evidence.

The resolver test exercises the actual added controller method with a synthetic loader, verifies its
void result, rereads a real upstream encrypted file, skips already-cached data and rejects oversize
before invoking the loader. Live blob retrieval/retention is not yet verified.


## Startup spool cleanup

MediaTransfer initializes once before any transfer starts. The backend renderer factory explicitly
awaits this initialization before enabling the upload client. While the caller holds exclusive
profile ownership, startup reads all unfinished upload references from SQLCipher and validates the
complete reference set before scanning the private spool directory. Any malformed reference stops
cleanup. Pending spools remain untouched; completed and unreferenced attachment-XXXXXX entries are
removed. This includes interrupted writes before preparation was committed, abandoned replacement
spools, and completed uploads whose process crashed before disposal. Unrelated names are preserved.
Directory iteration avoids materializing the full directory listing.

The parent must be a private real directory. Removal unlinks matching symlinks without traversing
their targets, including links nested inside abandoned directories. Repeated initialization on the
same MediaTransfer does not rerun cleanup while an upload may be preparing. The caller must use one
MediaTransfer per exclusively owned profile/spool directory; concurrent independent instances are
not supported. Active disk quotas and the 80-percent storage alert remain outstanding.

Tests reopen SQLCipher to simulate restart, retain a pending ciphertext file, remove orphan and
completed spools, preserve completed upload metadata, refuse malformed references and public/link
parents, and verify unrelated files and external symlink targets survive.
