# Native Agent console optimization

## Contract

Scry observes and controls native Provider runs; elapsed time, a slow renderer or a delayed
query is not proof that an Agent stopped. Keep Provider-specific permissions, execution trust,
renderer isolation, session identity and explicit stop semantics. No automatic replay of an
unconfirmed write. “Complete capture” means Provider-exposed evidence under the declared
redaction policy, not inferred data or an implicit decision to persist secrets.

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
  to an earlier turn. Pin the existing capture/redaction policy on retries.
- Tests: large outputs across current thresholds, interrupted writes/recovery, duplicates,
  redaction, disk errors and correct turn/session association. No raw-secret persistence by default.

### 3. Durable replay and pagination (CLI tool bodies partially implemented)

- Wire the existing Recorder byte-page reader into authorized App/mobile detail endpoints.
- UI/mobile/terminal consume durable cursor pages, with bounded in-memory caches and complete
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
