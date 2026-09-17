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
  local PTY disk capture/replay: terminal data remains raw but memory-only in this revision.

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
- Make export carry referenced blobs, then add explicit retention and orphan collection.
- Replace remaining adapter/body truncation and fixed transcript windows with streamed content and
  durable cursors; retain explicit original/saved byte counts where the upstream itself is partial.
- Collect full diffs asynchronously without changing turn ownership or attributing later changes
  to an earlier turn. Pin capture budgets and preserve historical provenance on retries.
- Tests: large outputs across current thresholds, interrupted writes/recovery, duplicates,
  raw byte preservation, disk errors and correct turn/session association. Follow the explicit raw-capture policy above.

### 3. Durable replay and pagination (CLI tool bodies and remote output partially implemented)

- Wire the existing Recorder byte-page reader into authorized App/mobile detail endpoints.
- UI/local terminal consume durable cursor pages, with bounded in-memory caches and complete
  catch-up after lost ACK, disconnect or renderer restart. Retention/deletion must be explicit.
- Tests: reconnect cursor continuity, no skipped/duplicated events, renderer overload, host restart.

### 4. Native interactions (not implemented)

- Preserve Provider-specific approval, questions/editor, option lists and background task contracts.
  Do not flatten them into an artificial common question limit or infer cancelled/successful state.
- Tests: delayed answers, large option lists, cancellation, provider/profile switches, concurrent tasks.

### 5. Long-lived console (not implemented)

- Incremental archive indexing, remote ledger compaction/pagination with durable deduplication,
  persisted drafts, large-file read-only views and directory pagination.
- Tests: beyond current count/byte thresholds, cold restart, concurrent append, stale cursor and
  user-authored draft recovery. Keep IPC/security boundaries intact.
