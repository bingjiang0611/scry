# Native Agent console optimization

## Contract

Scry observes and controls native Provider runs; elapsed time, a slow renderer or a delayed
query is not proof that an Agent stopped. Keep Provider-specific permissions, execution trust,
renderer isolation, session identity and explicit stop semantics. No automatic replay of an
unconfirmed write. “Complete capture” means Provider-exposed evidence, not inferred data.

The maintainer explicitly selected **all captured output, raw by default** during this workflow.
This supersedes the redaction policy described in the historical batches below. Newly captured
content may persist credentials; access control and execution trust are unchanged. Diagnostic/support
bundles, authentication errors and credential/config display retain their separate masking policies.

## Batch 1: avoid false termination (2026-09-17)

Implemented:

- Codex query/control response timeouts reject only that request, never kill a shared app-server.
  Late replies cannot resolve another request; notifications remain subscribed. Thread
  start/resume/fork and turn/start have no response deadline, retaining ownership until a reply,
  real transport failure or explicit shutdown. Initialization failure still cleans up the newly
  started process, before any turn can use it.
- Codex stop during a pending turn/start no longer returns an interrupted result immediately
  after sending interrupt. Native completion/process failure releases the run's activity lease.
- Pi run startup, prompt acknowledgement and settlement no longer have wall-clock deadlines.
  Entry identity discovery is event-driven and fails missing identity only after a post-settlement
  snapshot; malformed/conflicting identity still fails closed. Capability probes remain bounded.
  Explicit abort/force-stop and transport failures still release waiters. Fork/clone mutations
  also wait for the native response rather than automatically closing an uncertain operation.
- OpenCode stop no longer aborts the local long-running fetch and immediately fabricates an
  interrupted result. Accepted requests stay owned until the native prompt returns, native abort is
  confirmed, explicit shared-transport force-kill occurs or the transport fails. A completion that
  races with stop remains completed; a native abort remains interrupted.
- Terminal output pressure pauses node-pty reads instead of closing the terminal or discarding
  the received buffer. Renderer ACK drains the queue and resumes reads below the low-water mark.
- Recorder recovery no longer turns a silent open turn into an interrupted record after 24h,
  including missing transcripts. Real terminal/session-end/process-exit evidence still closes
  turns. `doctor` describes silence as termination unconfirmed and asks for investigation.

Boundaries, not claims of complete native parity:

- Terminal backpressure can block a producer writing to the PTY. It is not durable capture or
  crash/reload replay; node-pty's own exit/drain behavior is unchanged. The existing explicit
  workspace-switch/window-close/navigation/crash terminal teardown remains in place.
- Missing renderer ACK keeps reads paused rather than guessing that bytes were displayed.
  Explicit terminal close still works. Batch 2/3 must decouple reading/persistence from rendering
  with a durable output cursor; do not relax memory limits as a substitute.
- Native requests may remain pending indefinitely without a reply. Retain ownership and stop
  controls; do not auto-retry or silently admit a conflicting run. Codex shared-process hard kill
  is still not a safe per-run operation.
- Pi metadata/control query deadlines remain. OpenCode startup health checks are still bounded
  before a run is accepted; deleting that probe would not improve native execution ownership.
- Already-terminal Recorder `closing` states still have the existing evidence finalization grace.
  This batch removes fabricated open-turn endings, not every evidence truncation policy.

Verification on the working tree:

- A snapshot reconstructed from this batch's Git index (excluding unrelated working-tree changes)
  passed `npm test`: 161 files passed, 3 skipped; 2064 tests passed, 3 skipped; shell tests passed.
- The same staged-only snapshot passed `npm run typecheck`, `npm run build` and `npm run build:cli`.
- The staged-only snapshot passed `npm run check:cli-release` (526 tests plus package smoke).
- The staged-only snapshot passed `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:artifact`, including
  packaged-app checks and isolated Electron security/PTY/surface smoke. A separate staged-only real
  `node-pty` acceptance forced a 64 KiB backlog, observed paused reads, then verified ACK-driven resume,
  the complete marker and natural PTY exit. Development artifact only; no installation or publication.
- Pi silence/startup regressions use a real JSONL fixture subprocess and virtual parent timers;
  they are not a 31-minute external Provider acceptance test. Terminal overload is covered by
  deterministic bridge/manager tests; packaged smoke covers native PTY wiring, not sustained overload.
- A later staged-only lifecycle snapshot including the OpenCode stop fix passed `npm test`
  (164 files passed, 3 skipped; 2075 tests passed, 3 skipped), typecheck, Electron/CLI builds and
  `check:cli-release` (535 tests plus package smoke).
- Existing unrelated working-tree changes remain outside these commits. Passing these gates does
  not certify those changes or a separately installed Scry version.

## Batch 2a: durable Recorder tool bodies (2026-09-17)

Implemented for the canonical Recorder path:

- Tool input/output exposed to lifecycle hooks or parsed transcripts is redacted in full before any
  inline byte budget is applied. Each exposed body is written first to a content-addressed
  `.scry/content/sha256/` artifact, and the turn record carries a SHA-256/byte-count reference so a
  later shared turn budget cannot lose an otherwise-small field. Turn/field budgets still bound JSON
  records and in-memory projections.
- Artifact publication reuses the Recorder's durable exclusive-write primitive. Duplicate bodies
  deduplicate by digest; existing bytes and later reads are integrity checked. A storage failure
  rejects the evidence write instead of recording a false complete reference. Publishing before the
  record can leave an unreferenced blob after a crash, but cannot leave a committed dangling reference.
- Upstream partial/unavailable provenance is preserved. A complete artifact means all bytes Scry
  received after configured redaction, not bytes the Provider never exposed.
- Recorder archive journals enumerate and preflight referenced blobs, copy deduplicated content
  before source record removal, and publish the references in the archive manifest. Recovery accepts
  a verified target copy when the live blob is gone and upgrades older inline-only journals safely.

Current boundaries:

- This closes large tool-body loss in standalone Recorder lifecycle/transcript aggregation only.
  Provider adapter trace archives, terminal output, assistant text, diffs and App SQLite/outbox sinks
  still need the same durable-reference contract.
- Recorder archives now own their referenced blobs, but JSON-only `export` does not bundle them.
  Live blobs are retained because later records may share a digest; there is no retention/orphan
  collection policy yet. Do not treat an exported record JSON as self-contained.
- `scry turns content <record> <section> <index> <input|output>` resolves only references from a
  validated record and returns bounded base64 byte pages with stable offsets. A cold read verifies
  the complete digest; a bounded inode/mtime cache avoids O(n²) re-hashing while file identity is
  unchanged. The App/renderer still has no content-detail endpoint or paged viewer.

Verification for this batch on a snapshot reconstructed from the Git index:

- `npm test`: 164 files passed, 3 skipped; 2077 tests passed, 3 skipped; shell tests passed.
- `npm run typecheck`, `npm run build` and `npm run build:cli` passed.
- `npm run check:cli-release`: 537 tests plus package smoke passed.
- A large-output integration committed a bounded record preview, reloaded the record, resolved the
  complete redacted artifact byte-for-byte and verified a secret beyond the preview was never stored.
- Content-store tests cover shared turn-budget exhaustion, digest deduplication, unavailable storage,
  missing blobs, post-write corruption, exact byte pagination and cache invalidation. CLI integration
  reassembles a large Unicode body across non-character-aligned pages without exposing a redacted
  secret. Archive tests cover shared-blob deduplication, live-store independence, missing-source
  preflight, crash recovery from target content and legacy inline records.

## Batch 2b: durable remote run output (2026-09-17)

Implemented:

- Production `HostController` now uses a private, leased per-run output store instead of the 1 MiB
  in-memory live cache. Masked output is split on UTF-8 boundaries, batched within the event loop,
  appended to fsynced JSONL data, and committed through a fixed-width end-offset index only after
  the data is durable. The batch is flushed before the lifecycle can become terminal.
- Device cursors page from the index with a 512 KiB serialized-record budget (plus bounded read scratch
  space and parsed object overhead). Output beyond the former limit survives a clean host/controller
  close and reopen without a synthetic truncation marker.
- Recovery drops only uncommitted data/index tails. Missing file pairs, invalid offsets and corrupt
  records fail closed. A temporary persistence failure does not fail the Agent: the durable lifecycle
  records one `output_capture_failed` evidence gap, and a recovered store writes a `truncated` marker
  before later content.

Boundaries:

- This covers paired-device Agent output, not local terminal PTY output or renderer trace replay.
- There is not yet an explicit retention/compaction policy, so output files grow with retained runs.
  A slow durable flush can backpressure event projection, but batching prevents one fsync per streamed
  token; storage delay does not infer Agent termination or replay writes.
- Secret masking follows the existing remote-output policy; it is not a claim that arbitrary unknown
  secrets can always be detected.

Verification on a snapshot reconstructed from this batch's Git index:

- `npm test`: 165 files passed, 3 skipped; 2085 tests passed, 3 skipped; shell tests passed.
  An initial resource-contended run timed out in two unchanged tests; both passed alone and the
  subsequent full rerun passed.
- `npm run typecheck`, `npm run build`, `npm run build:cli` and `npm run check:cli-release` passed
  (537 CLI tests plus package smoke).
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:artifact` passed packaged-app validation and
  isolated Electron security/PTY/surface smoke; no installation or publication was performed.
- Remote-output tests replay more than the former 1 MiB cap after restart, exercise torn-tail repair,
  missing/corrupt file pairs, masking, bounded pages, recovered gap markers and durable failure notice.

### Follow-up: bounded capture and fail-closed index reads

Focused regressions exposed gaps in the initial implementation; this follow-up fixes them:

- A missing index can no longer be recreated on append and cause surviving data to be truncated.
  Invalid indexed lengths now throw rather than appearing as a caught-up/empty page. Before tail repair,
  the final indexed record is validated; reads validate the final record even for a caught-up cursor.
  This is local record/offset validation, not a full-file checksum or complete corruption audit.
- UTF-8 splitting is lazy and linear, preserves literal replacement characters and bounds queued
  output to 512 KiB of text and 4,000 events globally, including within a single large append.
  These are queue limits, not a bound on the upstream input string or masking allocation.
- The stored-line ceiling is 128 KiB to accommodate worst-case sixfold JSON escaping of a 16 KiB
  text chunk plus metadata. The page budget remains 512 KiB; this is not a larger capture window.
- At this revision, lease recovery after an unclean process death was still unimplemented; the
  subsequent startup-reconciliation batch below adds a deliberately bounded recovery path.
  These tail-repair tests only modeled torn writes after lease release, not automatic crash-lock recovery.
  Synchronous durable writes, retention and local replay remain open.

Verification on the final staged-only snapshot:

- `npm test`: 165 files passed, 3 skipped; 2097 tests passed, 3 skipped; shell tests passed.
- `npm run typecheck` and `npm run build` passed. An initial fault-injection test overload typing error
  was corrected, then focused checks, typecheck/build and the full suite were rerun on the final snapshot.
- The 24 output tests include real data/index fsync failures and a three-byte torn index write:
  uncertain bodies are not replayed, repair keeps contiguous cursors, and recovery emits a gap marker.
- No real paired-device or local-terminal replay was exercised, and no package/install/publish was
  performed for this follow-up. Earlier Batch 2b packaging results apply only to its original revision.

### Follow-up: trusted startup reconciliation after process death

- The production controller factory reconciles private pairing, ledger and output leases before
  opening each store. Only a valid bounded owner record plus `kill(pid, 0)` returning `ESRCH`
  permits recovery. A live/reused PID, `EPERM`, malformed/partial owner or unsafe file stays blocked;
  neither elapsed time nor lack of Agent activity is evidence of death. No process is terminated.
- Existing Recorder directory-lock recovery was inspected but deliberately not reused: its live-owner
  TTL is unsuitable for long-running remote sessions, and its async directory format differs from these
  synchronous file leases. Direct store constructors retain their existing exclusive-lock policy.
- Recovery takes one permanent, exclusive claim per old lease UUID, hard-links the exact owner as
  evidence, rechecks inode/device/content metadata, and syncs that evidence before removing the active
  name. The claim prevents competing recoverers from unlinking a successor's lease. Same-user hostile
  filesystem mutation is outside the product trust model; this is not a sandbox or general OS lock.
- Already-dispatched work stays `dispatched` (outcome unknown), never replayed or silently settled.
  Existing pairing grants and output cursors are restored; device-certificate authorization is unchanged.
  If controller construction rejects corrupt state, all newly acquired leases are released without
  replacing or repairing that authority state.

Deliberate limits:

- A process death *during recovery itself* can leave a claim plus active lock; startup then fails closed.
  Such cases need explicit local reconciliation after proving no owner/recoverer remains. Do not delete
  claims on a timer. If this case needs automatic recovery, introduce an OS-owned interprocess lock with
  crash-release semantics and migration tests, rather than adding another PID/TTL retry layer.
- Completed recovery claims retain small owner records until explicit state cleanup; no automatic GC
  is added. Process death before writing a complete lease record also remains blocked.
- This does not reconnect surviving Provider processes or prove uncaptured output complete, and does
  not implement renderer/local PTY replay.

Verification on the final staged-only snapshot (local Node 24/macOS):

- Remote suite: 22 files / 163 tests passed. A real-child test opens all three actual stores, rejects
  a second live owner, kills only that test child with SIGKILL, then restores grants, durable output
  and settled/dispatched states without executing the unknown run again. Synthetic tail writes and
  unit fault injection are separate from real Provider/device acceptance.
- `npm test`: 166 files passed, 3 skipped; 2115 tests passed, 3 skipped; shell tests passed.
- `npm run typecheck`, `npm run build` and `npm run check:cli-release` passed (537 CLI tests plus
  CLI build/package smoke).
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:artifact` passed packaged-app validation and
  isolated Electron security/PTY/surface smoke. No real paired-device or Provider restart was exercised;
  no installation, signing, publication or push was performed.

## Current policy: raw captured output by default

- Recorder defaults and `scry init` now use `capture.toolOutput: full`. Existing `full-redacted`
  configuration and persisted retry policies are accepted as migration inputs but no longer redact
  newly captured content. Explicit `none`/`summary` capture choices remain effective.
- Tool bodies, labels, SQLite span/intervention/usage payloads, managed journals/outbox/archive,
  transcript mirrors, remote output and Agent display/report text no longer replace credential-like
  strings. New tool content has `redaction: disabled`; safe-serialization failures have their own
  `serialization_failed` reason rather than claiming a redaction failure.
- Historical content and references retain their provenance (including applied redaction); no data
  migration pretends to recover lost bytes. Invalid objects, accessors, byte budgets, hash checks,
  source partial/unknown markers, workspace/session checks and device authorization remain enforced.
- README and CLI docs warn about credential persistence, backups, exports and upload callbacks.
  No new external upload or credential discovery was added. This policy change does not itself finish
  local PTY disk capture/replay; that is implemented in the bounded follow-up below.

Verification on the final staged-only snapshot (Node 24/macOS; synthetic credentials only):

- `npm test`: 166 files passed, 3 skipped; 2116 tests passed, 3 skipped; shell tests passed.
- `npm run check:cli-release`: typecheck, 538 CLI tests, CLI build and clean-package smoke passed.
  The first package smoke still asserted the obsolete full-redacted default; its assertions were
  updated to verify exact synthetic raw input/output, then the release check was rerun successfully.
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:artifact`: App/CLI builds, package checks and
  Electron security/PTY/surface smoke passed. The actual packaged App's smoke Provider emits
  synthetic credential-like input/output; archive reload through typed IPC preserves both strings.
- Renderer raw-name/report behavior is covered by focused render tests; no real Provider account,
  paired mobile device, production user data or real credentials were used. No install/publish/push.
- Code/tests/scripts in the staged index were hash-matched to the tested snapshot; existing unrelated
  worktree changes were merged back but excluded from this commit.

## Local terminal recording and exited-session replay

Scope and existing UI reuse:

- Production terminals record raw node-pty text by default under private
  `userData/terminal-recordings/<terminal UUID>.{bin,json}` files (0700 directory / 0600 files).
  No shell input channel is recorded separately; echoed input may naturally occur in PTY output.
- The existing terminal toolbar gains read-only replay and recording deletion, enabled only after
  Shell exit. Clear-screen remains separate from deleting the file. Replay reads one bounded page,
  awaits xterm's write callback, then requests the next; a restart/closed pane cancels further writes.
  The footer reports recording failure/partial replay and warns that raw content may include secrets.
- The typed preload exposes only recording ID + bounded byte cursor and exact-ID deletion. Main
  revalidates the trusted frame and current canonical workspace before reading or deleting; there is
  no renderer-supplied file path. Active recordings cannot be deleted, including failed captures.

Storage/evidence contract:

- UTF-16LE preserves the exact JS text emitted by node-pty, including surrogates split across native
  callbacks. This is not a claim to capture the original undecoded PTY bytes. Page cursors are even
  byte offsets in that encoding; default 64 KiB, maximum 256 KiB, with no split surrogate pairs at a
  normal page boundary. IPC string serialization has separate bounded overhead.
- Data is appended without retaining a growing body queue. Data fsync precedes atomic metadata
  publication; checkpoints are scheduled after 50 ms and forced on read/exit. That scheduling interval
  is not a durability deadline. A crash replays only the last published checkpoint, with an open record
  marked interrupted, not complete. Invalid/missing file pairs fail rather than look empty. The store
  validates private-file structure and lengths, not a full-content cryptographic checksum.
- Storage failures notify the renderer but do not terminate the PTY or suppress live projection.
  Uncertain body writes are not retried. Cold reads use the last visible checkpoint: an open prefix
  remains interrupted. If an exit checkpoint was renamed before directory fsync failed, and the
  failure marker also could not be saved, a surviving checkpoint can still prove complete received
  content (native exit plus already-fsynced body); the original sync failure was separately notified.
  Orphan startup/temp files are not silently deleted.

Remaining limits (not claimed complete):

- The existing renderer ACK backpressure and PTY cleanup on navigation/crash remain in place. This
  batch does not implement live reattachment, old-ACK fencing or reload survival. Disk history UI
  is covered by the follow-up below; it does not restore a live Shell.
- No retention/GC or disk quota is added. Closing a tab preserves its recording; the history follow-up
  below restores a UI handle for replay/deletion. Explicit retention controls remain a separate step,
  not a reason for silent eviction.
- Terminal writes/checkpoints now run in a dedicated worker behind a bounded main-thread queue (see
  the follow-up below). The remote run-output file store and several other evidence sinks still use
  synchronous filesystem calls; producer/UI/storage independence is therefore not yet a global claim.
- Replay restores received text at the current terminal geometry with the existing 5,000-line display
  scrollback; it does not promise exact historic resize/cursor state or unlimited in-memory scrollback.

Verification (staged-only source snapshot): 2,133 unit tests passed, 3 skipped; shell checks,
node/web typecheck, App/CLI builds, 538 CLI release tests and clean-package smoke passed. Packaged
App validation and isolated Electron security/PTY/surface checks passed. The native PTY/UI path
verified disabled recording controls while running, natural exit, clear → visibly replayed marker →
delete → restart. The replay smoke was corrected to await actual DOM painting after xterm parsing,
not to treat a parsed-buffer callback as a painted-screen assertion; the final rerun passed.
Synthetic sink tests cover >16 MiB, cold reads, Unicode/code-unit boundaries, uncertain body writes,
fsync/metadata failure, authorization and deletion. This is not a sustained >16 MiB native PTY pressure
test, visual screenshot review or real Provider acceptance. No installation or publication performed.

## Terminal capture worker follow-up

- Production terminal capture now owns the synchronous store in a dedicated Node worker bundled as a
  separate Electron main entry. Main sends at most one operation at a time and retains at most a
  4 MiB UTF-16LE queue plus one native callback chunk; batches are at most 512 KiB and do not split
  surrogate pairs. The worker preserves the existing fsync-before-metadata and unknown-write rules.
- Storage pressure and renderer ACK pressure are separate pause reasons. Releasing either cannot
  resume node-pty while the other remains active. The queue resumes below 2 MiB. A worker/store
  failure clears pressure, reports capture failure, refuses subsequent body writes for that recording
  and never terminates the Shell or retries an unknown write.
- Startup is ordered before body batches without blocking terminal creation on fsync. `available`
  means capture was admitted to the worker queue; a later startup failure is reported explicitly and
  the returned Shell keeps running. Read/list/delete operations share the same ordered queue, so a
  replay cannot pass earlier writes or terminal exit finalization.
- Graceful App shutdown initiates native terminal close, waits for exit or the existing bounded close
  grace, drains/finalizes capture, then terminates the worker. The existing global six-second shutdown
  deadline remains authoritative; exceeding it leaves the last published checkpoint partial rather
  than claiming a complete recording.
- This only removes terminal filesystem syscalls from Electron main. Buffer conversion and structured
  clone remain bounded main-thread work, and PTY pause still deliberately backpressures the producer
  instead of spilling unbounded memory. Remote output and other stores remain for later batches.

Verification (staged-only source snapshot): focused worker/client/store/manager/output tests cover
bounded batching, Unicode, independent pause reasons, worker failure, startup failure and no
unknown-write retry. The full suite passed 2,150 tests with 3 skipped; shell checks, node/web
typecheck, App/CLI builds, 538 CLI release tests and clean-package smoke passed. Packaged validation
and Electron security/native PTY/history smoke passed, proving the worker entry loads from ASAR and
retains exit/replay/delete plus crash-restart history. No install, publication, real Provider/device
acceptance or sustained slow-disk pressure test was performed.

## Terminal disk history follow-up

- The terminal toolbar opens a workspace-scoped history dialog using the existing `ModalFrame`,
  archive row styles and xterm panes. This is a same-pattern extension, not a visual redesign.
  Design-library search had no matching live record (one unrelated stale Pi record); no new reusable
  design asset or preference was created, so no design-library writes are needed.
- The list scans private recording metadata asynchronously, returning 20 summaries by default (max
  100). It retains only page-size + 1 summaries and the native directory iterator buffer, with one
  concurrent scan per store. No body previews, foreign workspace paths or record IDs are returned.
  Main rechecks canonical cwd after scanning and revalidates the trusted frame before responding.
- Pagination is lexicographic recording-ID order, not time order or a frozen snapshot. Deleting the
  cursor record is safe; newly inserted IDs before it appear on refresh. Each page rescans metadata,
  so I/O is O(number of index files), not O(page size). If catalog latency becomes material, add an
  indexed catalog rather than raising page/memory limits. No latency or million-record claim is made.
- Unreadable, unsafe or malformed metadata marks the page partial without disclosing unknown
  ownership. Missing bodies are detected during replay, not silently interpreted as empty output.
  The list describes the metadata checkpoint; it is not a body-integrity audit. Orphan `.bin`/temp
  files without readable metadata remain outside this catalog and cannot be authorized for deletion.
- New recordings store their capture-start time; old records show unknown time without rewriting
  their metadata. Active Shells are labelled and cannot be opened from history or deleted.
- History opens a distinct read-only tab (under the existing eight-tab bound), with stdin disabled,
  no start/restart call and no live terminal ID. It reuses bounded replay and explicit deletion;
  closing that tab leaves the file intact. `readonly` is separate from confirmed native `exited`.
  This does not resume detached processes or replay shell commands, even after an App crash.

Acceptance scenario: exit a native Shell, close its tab, locate and replay its disk recording, delete
it, then deliberately SIGKILL only the isolated test-owned App, wait for its actual exit, relaunch the
same userData and replay another saved recording through the history UI. Check no new recording is
created by opening history, old terminal-ID writes are rejected, and foreign workspace list/read
access is denied. The crash test is not proof of graceful App shutdown: an initial SIGTERM fixture
attempt did not confirm exit within its test deadline. The cold UI fixture also selects its workspace
through the sidebar (not a main-only cwd mutation) to keep renderer and main context consistent.
Final staged-only results: 2,144 unit tests passed, 3 skipped; shell checks, node/web typecheck,
App/CLI builds, 538 CLI release tests and clean-package smoke passed. Packaged validation and the
final isolated native PTY/history crash-restart smoke passed, including modal focus/visible bounds,
rendered replay text, explicit deletion, no new recording on history-open, rejected old-ID input and
cross-workspace denial. The smoke fences command injection and exit receipt on a newly observed
terminal ID rather than a possibly stale `running` CSS state, and waits for visible xterm content.
No screenshot visual review, real Provider/device acceptance, live reattachment or graceful-shutdown
claim is made. No installation/publication; the existing ACK backpressure and synchronous capture
writes remain unchanged.

## Live terminal renderer adoption

- Renderer navigation, crash and macOS window close now detach projection ownership without closing
  node-pty. App quit and workspace change remain explicit process-ending boundaries.
- Every start/attach issues a monotonically newer ownership epoch. Data and exit delivery carry that
  epoch; write, resize, ready, ACK and close are fenced by it. Delayed calls from an old renderer are
  rejected without changing the current owner's credit or process state.
- While detached, main drops the redundant renderer projection queue and releases its pause reason;
  the ordered terminal-recording worker remains the authority. Attach places a read checkpoint behind
  prior appends, replays exactly through that UTF-16LE byte offset, then enables live delivery. Output
  after the checkpoint stays buffered behind the new ready handshake, avoiding a replay/live gap.
- Active session discovery exposes only typed process metadata through trusted IPC. The terminal UI
  queries it before creating a new Shell, reconstructs live tabs, catches up each recording page and
  never closes a process merely because React unmounted. Explicit tab close still closes the owned PTY.
- If durable capture is unavailable or partial, adoption continues but labels the missing evidence;
  it does not present an empty replay as complete. Large catch-up remains sequential and bounded per
  page; a dedicated large-file view and retention/quota work remain later items.

Verification covers manager checkpoints and active metadata, exact replay boundaries, detached queue
release, stale ACK/write fencing, epoch-tagged delivery and preload payloads. The packaged Electron
smoke starts a real PTY, reloads the renderer, confirms the same process is still active, advances the
ownership epoch, replays the pre-reload marker from disk, rejects the stale owner and closes through
its new epoch. The unsigned local package path is used because this machine's Apple Development
signature is not a notarized distribution identity; no install, publication or real Provider/device
claim is made.

## Complete transcript snapshot selection

- Recorder transcript parsing no longer advances the start cursor to a fixed 32 MiB tail or persists a
  4 MiB rewind heuristic. It scans JSONL backward to the exact Provider turn ID / prompt-hash anchor,
  then reads through the stable end offset. If no trustworthy anchor is found it falls back to byte
  zero, so a large prompt or early tool event cannot disappear while a later terminal event remains.
- Legacy open-turn state may still contain `transcriptStartOffset`; recovery intentionally recomputes
  the anchor rather than trusting that heuristic. Snapshot identity checks before/after the read and
  path inode checks still prevent a rotated or concurrently changed file from being called stable.
- Focused regression covers a 33 MiB snapshot and a Claude JSONL prompt line larger than the old
  rewind budget, including exact Provider identity and assistant recovery.
- This correctness-first path parses the selected turn window in recorder/CLI memory; a missing anchor
  deliberately falls back to the full session. It is not an Electron renderer or IPC queue, but a
  single very large turn can increase recovery latency and peak RSS. When measured size/latency becomes
  material, replace it with a durable line index plus incremental parser state; do not restore a byte
  tail that silently changes completeness.

## Durable model and diff bodies

- `recorder-content-v1` is now the shared content-addressed body store, not a tool-only convention.
  Tool input/output, assistant text, reasoning segments and Git patch bodies publish a verified
  `sha256` reference before their JSON record is committed; the existing byte/base64 page reader
  resolves every reference type.
- Assistant/reasoning and patch fields retain bounded UTF-8 previews in the record. Ordered model
  segment references reconstruct streamed bodies; `DiffFile.patchContent` retains the complete patch
  even when the inline patch hits the per-file or per-record preview budget. Archive manifests collect,
  verify and copy these references before deleting live records.
- Recorder diff capture requests complete patches before projection. Binary files, explicit basename
  policy exclusions, Git errors and the enclosing capture deadline remain honestly unavailable; they
  are not relabeled as complete content.
- Managed App turns now persist raw tool and model bodies before `protectToolContent` applies its
  archive/SQLite projection. Pi no longer clips native tool results at 200,000 characters before that
  canonical sink. Live trace IPC backpressure remains bounded and non-canonical.
- The lifecycle adapter no longer drops model timing entries after item 200. Focused regressions cover
  Unicode assistant/reasoning bodies, a Unicode patch larger than the inline budget plus archive copy,
  250 model timing calls, managed App recovery and a Pi tool result above the former limit.
- A record now also carries immutable evidence for the exact stable JSONL byte range used by its
  parser: canonical source path, inode identity, start/end offsets, completeness, and a verified
  content reference. Rotation or deletion of the mutable Provider transcript cannot invalidate that
  record, and recorder archive moves copy the referenced bytes before removing the live source.
  Explicit prompt/assistant or full-body policy opt-outs keep this evidence `disabled` rather than
  bypassing the user's capture policy.

## Complete content access and export

- `scry turns content` now resolves a typed record content path rather than only tool input/output.
  Tool, assistant/model segment, diff patch and transcript references all use the same authorized
  workspace store and byte/base64 cursor (`offset`, `nextOffset`, `hasMore`), so Unicode can be
  reconstructed without relying on character boundaries.
- `scry turns export-bundle <directory>` publishes an independent directory atomically. It validates
  every record, deduplicates all referenced blobs by SHA-256, verifies/copies them, writes a manifest,
  then renames the completed temporary directory. A missing/corrupt body or an existing target fails
  before publication; ordinary paged `turns export` remains the lightweight record-only API.
- The content inventory is derived from the validated record contract, covering tools/skills/MCP,
  ordered assistant/reasoning references, diff patches and transcript ranges. This same inventory is
  also the archive dependency authority, avoiding a second list that can silently omit new bodies.
- The App can page tool input/output bodies through a trusted IPC tied to the current canonical
  workspace. Main revalidates the reference against that workspace's records on every page and caps
  reads at 64 KiB; renderer keeps at most eight decoded pages and preserves split UTF-8 code points
  with a streaming decoder. A stale view from another workspace therefore cannot turn a known digest
  into arbitrary recorder access.

## Remote history and intent recovery

- The authenticated mobile channel now exposes `historyPage` with a 64 KiB byte cursor instead of
  truncating the newest 120 transcript entries. Each response carries a SHA-256 snapshot fence and
  total byte count; stale, malformed and out-of-range cursors fail explicitly. The Swift transport
  and iOS client drain all pages before decoding, so reconnect and host restart read the same durable
  session history without treating a prefix as complete.
- Remote intent identity is scoped to the authenticated device certificate fingerprint. Reusing a
  client intent ID from another paired device no longer aliases the first device's ledger entry, and
  reusing one scoped ID with different intent bytes fails with `intent_payload_conflict` instead of
  returning an unrelated recorded result.
- The append-only ledger rejects an entry that would cross its 8 MiB restart-readable bound. This is
  deliberate fail-closed capacity behavior: an accepted append must remain readable after restart;
  compaction is still required before this becomes a long-lived unbounded ledger.
- Session catalogs and one-level directory listings now use 100-item, snapshot-fenced pages on the
  authenticated mobile channel. The iOS client validates monotonic cursors, stable totals and stable
  directory identity while draining all pages; the older capped endpoints remain compatibility-only.
  Snapshot changes fail explicitly rather than mixing two catalog/directory states.
- The iOS client atomically checkpoints a pending intent (including its exact routing/attachments)
  before any network submit, then replaces it with the host run ID after receipt. A cold launch never
  replays an unresolved write automatically: it offers an idempotent retry with the original intent
  ID. A received active run resumes read-only ledger/output observation from cursor zero so visible
  state is reconstructed without skipping unpersisted UI data. The file uses iOS data protection and
  is retained across observation failures, then removed only after terminal output drains or the user
  explicitly resets/unpairs.

## Remaining sequence

### 1. Finish native lifecycle parity

- Audit OpenCode stop-before-session and native abort-failure behavior against real server versions;
  keep bounded pre-acceptance health probes separate from accepted execution ownership.
- Audit remaining Pi metadata waits and Codex stop-before-identity/late-response behavior against
  real native contracts. Preserve unknown outcomes and safe process scope.

### 2. Complete evidence capture (partially implemented)

- Extend the Recorder content-reference contract to Provider adapter trace progress/outbox/archive,
  terminal output, assistant text and diffs before UI projection. Reuse existing sinks rather than
  creating a parallel archive.
- Export now carries referenced blobs. Recorder maintenance exposes soft quota and retention pressure,
  age-gated orphan/temp collection and rotated-log gzip. It refuses mutation while open turns,
  archive recovery, another recorder lock or a recent temp can still own data; referenced evidence is
  never deleted to force quota compliance.
- Add content references for any remaining generic harness/runtime metadata body that becomes subject
  to a storage bound; current canonical trace archives keep those fields inline without truncation.
  Retain explicit original/saved byte counts where the upstream itself is partial. Transcript
  selection and immutable range retention are complete, but the full-session fallback parser should
  move to a durable incremental line index when measured size/latency requires it.
- Collect full diffs asynchronously without changing turn ownership or attributing later changes
  to an earlier turn. Pin capture budgets and preserve historical provenance on retries.
- Tests: large outputs across current thresholds, interrupted writes/recovery, duplicates,
  raw byte preservation, disk errors and correct turn/session association. Follow the explicit raw-capture policy above.

### 3. Durable replay and pagination (CLI tool bodies and remote output partially implemented)

- Wire the existing Recorder byte-page reader into authorized App/mobile detail endpoints.
- Local terminal consumes bounded recording pages and catches up across lost ACK, disconnect and
  renderer reload with ownership fencing. Mobile session history now uses snapshot-fenced byte pages
  and is sourced from durable host history after reconnect/restart. App/mobile Recorder detail views
  still need the same authorized cursor contract.
- Tests still needed outside the terminal path: real-device cold-launch/reconnect continuity,
  long-running renderer overload and retention/deletion policy.

### 4. Native interactions

- Native Codex/OpenCode questions now preserve up to 100 bounded prompts/options. Pi input/editor
  requests keep single-line versus multiline semantics and the renderer uses a dedicated textarea.
  Codex secret prompts fail explicitly instead of silently sending empty answers.
- Codex/OpenCode stop requests surface native interrupt/abort rejection, never replay an abort with an
  unknown outcome, and still wait for authoritative completion after an accepted request.
- Provider-native background task support remains capability-specific; Qoder is the only runtime that
  currently exposes it, so Scry does not fabricate controls for the other Providers.

### 5. Long-lived console (partially implemented)

- The desktop workspace tree now drains opaque, snapshot-fenced 200-entry pages instead of silently
  stopping at 2,000 entries. A changed directory invalidates the cursor rather than mixing versions.
- Text files above the 2 MiB editable limit open through a dedicated 64 KiB read-only page API. Main
  re-authorizes cwd/path on every page, rejects symlinks/binary/invalid UTF-8, fences file identity,
  and renderer retains only the visible page plus byte offsets; editing remains unavailable.
- Still required: incremental archive indexing, remote ledger compaction beyond the current
  fail-closed 8 MiB file, and persisted desktop composer drafts.
- Tests still required: cold restart, concurrent append, stale ledger cursors and user-authored draft
  recovery. Keep IPC/security boundaries intact.
