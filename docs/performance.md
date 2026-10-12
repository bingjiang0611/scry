# Scry performance baseline and budgets

This document defines repeatable local performance checks. Performance data is local and content-free: timings may include Provider ID plus numeric counts/bytes, but never prompts, paths, tool output, credentials, or attachment contents.

## Instrumented paths

Set `SCRY_PERF_LOG=1` before starting Scry to emit one-line JSON samples prefixed with `[scry:perf]`.

- `app.startup`: database readiness, window creation, and deferred recovery completion.
- `agent.start` and `agent.first_provider_trace`: renderer request admission/registration and launch-to-first Provider event, kept separate from total Provider execution time.
- `agent.terminal_finalize`: Provider terminal handling split into renderer notification, diff completion, archive commit, and SQLite projection; `committed=0` identifies degraded/failed canonical recording paths.
- `session_history.load`: catalog lookup, archive read, Provider transcript parse, merge/enrichment, visible-page attachment hydration, total/returned turn counts, and transcript byte count.
- `session_history.load_older`: indexed archive-page or normalized-cache paging and visible-page hydration.

Provider execution time must be evaluated separately from Scry overhead. A visible terminal event also does not imply that every independent persistence surface has committed.

## Repeatable local benchmarks

```bash
npm run bench:session-history
npm run build:cli
npm run bench:git-diff
```

The history benchmark compares the previous eager behavior against two bounded paths:

1. merge 4,000 turns while hydrating only the 40 visible turns;
2. read 40 indexed per-turn archives from a 500-turn session instead of parsing every file.

Benchmarks are informational, not timing gates. Run them on the same machine and otherwise idle checkout; compare medians and inspect variance.

## 2026-09-21 repeated legacy-history load

A Pi archive with 8 turns and 741 tool events was read without modifying the source; all content-store writes went to a temporary directory. On the local macOS / Node 24.18.0 checkout, one before/after sample of the same archive measured:

| Stage | Before | Optimized |
|---|---:|---:|
| Archive read and parse | 64 ms | 67 ms |
| Re-project raw events with their content blobs already on disk | 21,254 ms | 415 ms |
| Merge after that repeated projection | 7 ms | 7 ms |

The repeated projection previously attempted a durable exclusive write for every tool body before discovering `EEXIST`. `writeRecorderContent` now reads and verifies the existing size and SHA-256 first, then syncs the published link's directory. Missing blobs still use the original durable exclusive writer; concurrent publication, corruption and sync errors are not treated as success. This path needs no in-memory cache to survive restart.

Scope: these are single-stage measurements, not an App restart/UI acceptance or a statistical benchmark. First materialization into an empty content store remains expensive (24.6 s before / 32.6 s after in these samples); the improvement is reuse, not faster initial migration. No archive bytes, evidence or full-content links are discarded. The focused regression in `src/core/turn-recorder/content-store.test.ts` proves reuse avoids the writer and preserves corruption/concurrent-publication/sync-failure behavior; it failed on the old implementation.

### Follow-up: selected-but-empty history

Repeated native clicks on an already-selected, still-loading session restarted `agent:loadSession` (cancelling the previous request) and set renderer loading to false. The resulting placeholder incorrectly looked like an empty session. The selection guard now keeps the pending request/generation, and the timeline explicitly reports history loading. The `repeat-pending` Electron fixture failed before the fix and passed afterward, alongside late-startup, same/cross-provider, rapid-switch and focused-run scenarios:

```bash
node scripts/session-capability-ui-smoke.mjs --selection-only
```

A current production build (main/preload/renderer together) was also launched twice against an isolated copy of a 3-turn Pi archive, with temporary HOME/workspace/userData and all Providers disabled. Native repeated clicks issued one history request per launch; both launches displayed all 3 turns and cleared loading. Main history load took 6,395 ms on first materialization and 1,574 ms after process restart. Original user records were not changed. This verifies archive/display restoration, not real Provider execution. The installed App also displayed that history after a single selection during inspection, but the reported ten-minute continuous stall was not reproduced; these changes do not claim to explain every such stall. The installed App was not replaced by this verification.

## 2026-09-16 reference run

Environment: Apple silicon, macOS 27.0, Node 24.18.0, Scry 0.2.148. Vitest reports `hz`; mean values below are derived from that run and are not cross-machine thresholds.

| Scenario | Before | Optimized | Relative |
|---|---:|---:|---:|
| 4,000-turn merge, 40 visible, real 1 KiB PNG attachments | 1,098.5 ms mean | 31.3 ms mean | 35.1× faster |
| 500 segmented archives, 40 visible | 118.7 ms mean | 15.7 ms mean | 7.5× faster |
| 10,000 segmented archives, 40 visible | 3,068.7 ms mean | 20.9 ms mean | 146.6× faster |

An isolated instrumented production-build launch reported database ready at 50.7 ms, window creation at 268.2 ms, and deferred recovery complete at 525.4 ms. Electron process launch is outside those in-app checkpoints.

The same run's Git baseline:

| Scenario | p50 |
|---|---:|
| Clean worktree | 244.1 ms |
| 3 small untracked files | 1,004.7 ms |
| 300 small files | 1,003.5 ms |
| One 50 MB untracked file | 1,853.1 ms, deadline fallback observed |
| Clean first-turn + session baseline reuse | 147.7 ms vs 222.4 ms separate, 33.6% lower |
| 300-file baseline reuse | 2,629.9 ms vs 2,991.1 ms separate, 12.1% lower |

The run had noticeable filesystem variance, especially the large-file case. It supports keeping the existing bounded deadline and shared baseline; it does not establish a universal latency target.

## Implemented scaling boundaries

- Live trace uses 16 ms IPC batching, byte/event high-water limits, renderer ACK, and explicit degraded resynchronization.
- Initial history IPC and renderer mount remain bounded to 40 turns (maximum requested page 200).
- Historical attachments are hydrated only after page selection, so invisible images do not enter main-process memory as base64.
- Archive-only Claude/Codex/OpenCode sessions use a rebuildable per-turn index and read only requested archive files in steady state. Turn commits invalidate the sibling index in O(1); the first later read rebuilds it once from canonical files, then freshness needs one directory stamp rather than one stat per turn.
- Qoder/Pi retain full-history enrichment because their Provider adapters add evidence across the loaded history; correctness takes priority over applying archive-only paging to those providers.
- Native Claude transcript history is still parsed as a whole before merge. Its identity validation and cross-source reconciliation make byte-range pagination a separate format migration rather than a safe substring optimization.
- Only one normalized full-history cache is retained, and it is invalidated on session/context changes. Renderer turns use memoized projections and off-screen `content-visibility`.
- The analytics surface is a lazy renderer chunk; the production entry chunk dropped from 1,376.07 kB to 1,348.50 kB in the verified build (about 27.6 kB deferred).
- SQLite query caches and recorder record-directory indexes are revision/stamp bounded; Git turn/session captures reuse a baseline where identity permits.

## Streaming render, main-process scheduling, and resource release

These paths were audited rather than rewritten: the existing implementation already bounds the cost, so the deliverable is instrumentation plus regression guards, not speculative new code.

- Streaming render is already bounded. `UserMessage`/`AssistantTurn` are `React.memo`, and `mergeActiveRun` rebuilds only the active turn while preserving the object identity of every completed turn, so a trace tick re-renders one turn rather than the whole transcript. The memo props from `App`/`ChatView` are referentially stable during streaming (`useState`/`useCallback` handlers, an array whose reference only changes when a question arrives, and `onForkTurn` that collapses to `undefined` while busy). `useAgentSession.test.ts` now asserts the identity invariant directly, because that invariant — not the `memo` wrapper alone — is what keeps the list cheap. Off-screen turns also use `content-visibility`.
- Main-process scheduling is sampled, not guessed. `SCRY_PERF_LOG=1` emits ordered checkpoints for startup, run admission/registration, launch-to-first-trace, and terminal finalization (renderer notify / diff / archive commit / SQLite projection), so a slow phase can be located from evidence and compared across runs instead of inferred. Provider execution time stays separate from Scry overhead.
- Resource release is bounded and tested. On any terminal outcome the run's `.finally` calls `runStopLifecycle.settle` (which cancels every pending upgrade timer), `userQuestionBroker.cancelRun`, and `runs.remove`; these paths are covered by `run-registry.test.ts`, `run-stop-lifecycle.test.ts`, and `user-question.test.ts`. Per-context session maps are deleted on session switch, terminal, and commit rather than only written. Composer drafts are LRU-bounded to a fixed number of session identities and revoke evicted blob preview URLs, with a `render.test.tsx` regression proving eviction and release. No unbounded growth surfaced in the audited paths, so no additional release logic was added.

## 0.2.150 current-worktree follow-up

The post-baseline fixes keep canonical evidence semantics unchanged while removing the remaining scaling cliffs:

- Canonical turn commits no longer validate or rewrite the global recovery catalog. They leave one durable dirty marker for the next catalog discovery, while a healthy per-session page index is updated after the canonical rename instead of invalidated.
- Catalog recovery used by project listing now scans canonical files with asynchronous filesystem operations, so a dirty recovery tree does not monopolize Electron main. A write-generation check retains the dirty marker if a turn is committed during discovery; publishing the catalog and clearing the marker do not yield between operations.
- Per-session page indexes are limited to 32 MiB and 100,000 entries on both read and write. Beyond that, canonical files remain readable via full scans (including subsequent page requests); if real sessions approach this limit, replace the derived index with bounded pages before raising the synchronous parse budget.
- In an isolated 500-turn write probe, mean milliseconds per write for successive 100-turn buckets were `1.79 / 1.39 / 2.20 / 1.53 / 1.56`; the previous path increased with total global archives. The 500-turn history benchmark setup now completes instead of timing out, and commit plus indexed 40-turn read measured 18.7 ms mean in the reference run.
- Completed Markdown only splits at verified top-level heading boundaries. Heading-free prose, HTML-bearing documents, cross-document references/footnotes, a single large table, and a single long fence stay as complete selectable text until the user explicitly requests full formatting. Isolated server-render means were 0.4–1.1 ms for the benchmarked guarded shapes.
- Collapsed tool groups no longer mount their tool bodies. Top-level text deltas no longer invalidate the stable tool timeline memo, and Overview/Diff derivation is skipped or memoized when there is no visible consumer.
- Diff preview trailing captures now observe the same minimum interval as ordinary captures. Database outbox recovery runs after first-window creation in bounded event-loop batches.
- Claude transcripts at least 4 MiB are read and normalized in a dedicated one-shot worker. A packaged-worker probe parsed and transferred a synthetic 11.5 MiB / 10,000-turn transcript in 101.5 ms wall time while the main-thread 1 ms timer saw a 3.8 ms maximum gap.

These are isolated local measurements, not universal timing gates or real-Provider latency claims.

### Delivery verification (2026-09-21)

Verified an isolated source snapshot based on `106e0e7`, containing only this performance patch (macOS arm64, Node 24.18.0). `npm test` passed 188 files / 2,344 tests with three explicitly disabled external probes; typecheck, build and renderer UI fixtures passed. Wide and narrow fixtures now start fresh and require deferred Markdown/tool mounting, including collapsing again. Removing the catalog generation guard makes its concurrent-write regression fail; restoring it passes. A GFM regression compares split and whole-document HTML, including fence-like lines that are not valid closing fences.

Current isolated benchmarks: indexed 40-turn archive reads average 7.87 ms versus 97.25 ms for all 500 files; commit plus page read averages 9.77 ms. The built worker parsed 12,297,779 bytes / 10,000 turns in 85.1 ms with a 2.2 ms main timer maximum gap; its entry bytes match the packaged ASAR. This is a Node worker probe, not proof of packaged Electron launch.

Failures retained: the first snapshot's packaged smoke missed the Agent menu after a fixed 50 ms sleep; the fixture now waits for the observable menu within its existing 2 s UI deadline, and a diagnostic run passed. The final snapshot's package build succeeded, but private CLI `--version` was killed twice with SIGKILL. macOS logged `Unable to apply provenance sandbox` for that exact executable despite a successful deep/strict codesign verification. At that point final packaged runtime acceptance was **unverified**; the failures are retained rather than replaced by later success.

Acceptance follow-up on the same day: after a read-only comparison with the previously working artifact, the **unchanged final artifact** returned CLI version `0.2.45`. Both `npm run check:packaged-app` and `npm run smoke:electron` then passed against that exact bundle. The package was 284,353,305 bytes (within budget); sandbox preload, private CLI and native resources were present. Packaged smoke verified terminal lifecycle, renderer reload/replay and stale-owner fencing, recording/history restart with read-only replay, modal focus, subframe preload isolation, and blocked navigation/popups. No rebuild, re-signing, relocation or OS policy change was used. The system-policy error's underlying cause is not established.

Source files were compared individually against performance commit `06be0c68a393c5ba258fb7d8dd6ee454ecd566ea`; only this delivery document differed. Before/after SHA-256 values were unchanged:

- `Contents/MacOS/Scry`: `33ccaeb8a3c32eaf41a21da2ff4f9702e780e9bc18900589d23d9be338c35299`
- `Contents/Resources/app.asar`: `4529dfc7a77a0394cdbc68fcff9117dad0bbd71e83b9cc4d1a05d28ea286e5f5`

Local performance and packaged-fixture acceptance is complete for that commit. This does **not** claim installation, notarized release, real Provider/account verification, or acceptance of unrelated dirty worktree changes. The disabled billing/P0/P1 external probes remain unrun.

## Pinned summary and targeted streaming checks (2026-10-09)

Pinned summary reuses Overview's 200 ms sampling hook. Ingestion is unchanged; terminal snapshots and loaded-session changes render immediately. Text is not discarded because it can contain web references and child-agent evidence.

- `node scripts/session-capability-ui-smoke.mjs --summary-only` exercises real React DOM: bounded updates, immediate terminal/switch, trailing text, and unmount/remount. Included in `test:renderer:ui`.
- `npm run bench:renderer -- --testNamePattern='trace batch scaling'` measures one text delta after 1k/10k/50k structural events without launching Providers.
- `node scripts/performance-animation.mjs` opens a temporary GPU-enabled window with eight production-CSS running indicators. It compares animated/static states in ABBA order, reports per-process one-core CPU, then removes temporary data. It does not alter running sessions.

Local measurement: Apple Silicon, 10 logical cores / 32 GiB, Electron 42.10.1, other workloads running.

| Check | Result |
| --- | --- |
| 36 summary updates over about 0.63 s | Old implementation: 37 displayed snapshots, regression fails. Sampled: 4; terminal/switch/trailing/remount pass. |
| One delta after 1k / 10k / 50k events | Mean 0.049 / 0.602 / 4.602 ms; p99 0.163 / 2.105 / 12.532 ms. |
| Eight animated indicators | GPU 4.97–5.18% one-core CPU; static 0.03–0.06%. Renderer 2.67–2.77% versus 0.01–0.06%. |

These are scoped observations, not full-App latency or memory-leak evidence. No event-index cache or animation behavior change was made. Revisit an append-only trace fast path if profiles show batch application taking a material share of the frame budget (especially around 50k structural events); preserve corrections, supersession, ordering and restore semantics. Summary sampling still scans loaded history roughly five times per second while busy; if that scan itself becomes a measured long task, cache completed-turn inputs without dropping cross-turn Agent or text evidence.

### Local 0.2.161 verification

- Node 24.18.0: full unit suite 194 files / 2,446 tests passed; three opt-in external probes skipped. Shell suite and complete renderer UI suite passed. The first full command was interrupted by the harness's 180 s deadline; after confirming no test process remained, the completed run took about 199 s without changing test timeouts.
- Typecheck passed on Node 24 and 22.22.1. CLI release check passed on Node 24.18.0 + npm 10.9.4 (563 tests plus installed tarball smoke); build, packaged resource checks and packaged Electron security/interaction smoke passed on the same toolchain. Private recorder CLI remains 0.2.47.
- Retained environment failures: npm 12.2.0 changed `pack --json` from an array to an object, so the existing tarball smoke failed before switching to npm 10. Node 22's full CLI suite twice timed out on the pre-existing 5 s EPIPE fixture under contention; its focused rerun passed in about 2.2 s. This does not establish a passing full Node 22 gate. No timeout, assertion, or production CLI behavior was changed.
- The new summary fixture initially waited for an anchor, but web references are static spans; its selector/readiness check was corrected. The final regression fails the old summary and passes the sampled summary. Component sampling evidence is separate from packaged full-App smoke and does not claim real-Provider performance acceptance.

### Installed artifact

Parallel main-process edits appeared during packaging, so final delivery was rebuilt from clean detached commit `75b58a9`, with an independent copy of dependencies. That snapshot passed typecheck, the full 2,446-test unit/shell run, renderer UI, and the 563-test CLI release gate on Node 24.18.0 / npm 10.9.4.

The isolated package's first combined command reached Electron smoke but exceeded the harness's 360 s deadline. No owned App process remained afterward. A diagnostic copy adding only CDP progress logging passed, followed by the original unmodified packaged checks/smoke on the same artifact. The first timeout's cause remains unknown; it is not erased by the later passes. Executable and ASAR hashes were unchanged across final checks.

The repository's atomic installer installed this locally development-signed, non-notarized 0.2.161 artifact at `/Applications/Scry.app`, preserving `/Applications/.Scry.app.backup`. Installed bytes matched the verified artifact:

- `Contents/MacOS/Scry`: `fd406b3958346fbe4b0319723241662b2bcaf2896ce7b3f83e4199c083b8de48`
- `Contents/Resources/app.asar`: `b8a2d0ae07abe8f48a94259789de6c2af85cd2d5091afe16da5a20e07fcf8388`

The pre-existing Scry process was not restarted; the new code takes effect on its next launch. This installation does not establish live multi-Provider performance after restart.

## Conversation pipeline follow-up (not included in the installed `75b58a9` artifact)

- Composer text now uses a synchronous session-scoped external store. Only the composer subscribes to ordinary text edits; App subscribes to attachment identity and slash-command tokens. Send, restoration and native-session migration read the same latest snapshot. The transcript list is memoized separately.
- Draft serialization (including image data) is coalesced at a fixed 250 ms interval, not postponed indefinitely while typing. Page hide, hidden visibility and unmount flush the latest snapshot. An unclean process crash can lose the last interval of draft edits; this is not a durable-per-keystroke guarantee. Revisit separate text/attachment persistence if measured serialization still exceeds the input budget; do not discard attachment bytes.
- Pi's optional model-window query no longer blocks prompt admission. Native model/effort changes, entry baseline and managed recorder identity remain ordered. Missing telemetry stays unknown; pending RPCs retain the transport's existing cleanup semantics.
- Tool events first deliver a bounded, provenance-bearing preview in live FIFO order. Disk persistence remains serial; successful writes enrich the same event id with the durable content reference. Text no longer waits for earlier tool bodies to sync. Recording still drains persistence; disk failures retain raw evidence, and renderer backpressure remains enabled.
- A main-owned `runtime:provider_ended` event distinguishes Provider completion from recording finalization. The UI says “记录收口中”, keeps follow-ups queued and disables the now-irrelevant Provider stop button. Existing Provider-specific `turnDone`, trust, recovery and Git-before-modification semantics are unchanged.
- `SCRY_PERF_LOG=1` now includes `agent.first_text` (request-to-first nonempty Provider text, **not renderer paint**), with registration/Git-ready/launch checkpoints; recovery/trust stages are expanded. `agent.trace_content` separates queue wait from persistence. The snapshot checkpoint belongs to `first_text`, since `agent.start` has already finished at run registration.

### Verification and remaining limits

- The native Electron composer regression failed the previous state-owned host and now passes at wide/narrow sizes: typing causes zero conversation-host renders, immediate Enter reads the latest text, and IME/history/focus behavior remains intact. This is a production-component fixture, not real-Provider latency evidence.
- The Pi regression with an unanswered model query failed the old awaited path (no prompt within 10 s); the asynchronous path passes, as do all 71 Pi tests. This uses an isolated local RPC process, not an account.
- A blocked-disk test proves tool/text/provider-terminal ordering before persistence completes, durable body readability afterward, and failure drain. Renderer tests prove same-id enrichment does not add a second tool event or mark the turn done.
- Final full unit/shell run: 195 test files / 2,453 tests passed, three opt-in external probes skipped. Final typecheck and production build passed. Complete renderer UI suite (including Credits, session transitions and terminal fixtures) passed.
- Retained development failures: the first new ingestion assertion incorrectly bounded the whole result envelope to 12 KiB (the existing contract repeats the 8 KiB preview in text/output aliases); it was replaced with the actual field-budget assertion. Initial typecheck exposed a Node-test import of renderer-only path aliases; the assertion was moved to the renderer suite without changing production tsconfig.
- The additional full built-App `node scripts/electron-security-smoke.mjs --dev` run **failed** late in cold terminal-history restoration. The restarted Electron renderer logged `binding.startupData` null / `preloadScripts` before the terminal menu timeout. Earlier assertions completed, but the complete run is not passing evidence; no baseline attribution or retry is claimed. Owned App PIDs were gone after cleanup. Log: `/tmp/scry-dialog-app-smoke.log` (ephemeral).
- No real Provider throughput/first-paint comparison, release packaging or installation was performed for this follow-up. Git/trust/recovery timing remains workload-dependent; this change does not claim to eliminate those necessary waits.

## 0.2.162 local reinstall

The conversation-pipeline changes from `7f92982` were packaged as App 0.2.162; private recorder CLI remains 0.2.47. Node 24.18.0 with the installed npm 10.9.4 was used (a temporary PATH shim, no global toolchain change).

- Typecheck, all 2,453 unit tests (three opt-in probes skipped), shell tests, all renderer UI checks, CLI release checks (563 tests + tarball smoke), production build and packaged resource checks passed.
- The first `install:mac:dev` stopped before installation: packaged Electron reported `binding.startupData` null / missing preload. A read-only diagnostic observed CDP publishing the file target with an empty title while the document was still loading. The smoke now waits for the static `Scry` document title before enabling Runtime; all preload/security assertions remain unchanged. This fixes an evidenced readiness gap, but does not prove the native error's full cause.
- The next smoke exceeded the 180 s harness deadline. Partial synthetic terminal recordings were present; no owned packaged App process remained. Its exact stall remains unknown. A temporary diagnostic copy adding only evaluation progress logs passed; the repository smoke then passed unchanged on the same artifact, including cold terminal-history recovery. First failure/timeout are retained, not replaced by those passes. Ephemeral logs: `/tmp/scry-0.2.162-install.log`, `/tmp/scry-0.2.162-smoke-ready.log`, `/tmp/scry-0.2.162-smoke-diagnostic.log`, `/tmp/scry-0.2.162-smoke-final.log`.
- After the final packaged resource and smoke checks passed, `node scripts/install-macos.mjs` completed the original install command's remaining atomic-install step. `/Applications/Scry.app` reports 0.2.162; its private CLI reports 0.2.47. Previous bundle retained at `/Applications/.Scry.app.backup`.
- Installed executable and ASAR compare byte-for-byte with the tested development-signed, non-notarized artifact: executable SHA-256 `3193f3798f0cbacf366c8242b664a67b15e2351df48e0af34aeadd3e2c0f4c9f`; ASAR SHA-256 `0a098bbffba9f90fe63dbd2b14fd0aee2083d5ed8bd8d6d7d3470b7af855b1b6`.
- The user's already-running Scry process was not stopped. Relaunch is required to use the installed code. No real Provider latency/throughput or signed/notarized release acceptance is claimed.

## First-output preparation: redundant admission and Pi controls

- `agent:start` still validates session ownership before draining, after draining, and before committing admission. Each check now loads catalog aliases lazily: an unspecified/new/exact native session needs no catalog read; run-ID aliases and local-only shells still resolve against a fresh snapshot. No aliases are cached across waits.
- Pi compares requested model (upstream provider + model id) and thinking level against this run's fresh `get_state`, including pooled processes. Unchanged model + explicit effort no longer issue `set_model` / `set_thinking_level`. If effort is omitted, an explicit model selection still calls `set_model` to preserve native thinking-default application. Model changes still precede explicit thinking selection: a switch can clamp/reset thinking, so the old level cannot justify skipping it. Permission, trust, entry baseline and recorder gates are unchanged.
- Streaming remains bounded by the existing 16 ms main-process batch and renderer frame scheduling. Existing blocked-disk/FIFO/backpressure/projection tests pass; no measured UI bottleneck justifies removing batching. Reviewed native dispatch paths do not show duplicated history injection, so prompt contents and Provider cache policy are unchanged.

### Local evidence (Node 24.18.0, App source 0.2.172)

| Check | Result | Scope |
| --- | --- | --- |
| Cached catalog benchmark, 10,000 entries, three checks | Eager mean 1.3017 ms; direct lazy path below 0.001 ms; alias resolution mean 1.5142 ms | Real temporary catalog, same-machine microbenchmark, not full send latency |
| Pi RPC controls | Unchanged model + effort: two setters reduced to zero; changed controls remain ordered | Isolated native-process fixture, cold and reused process, not real Provider |
| Focused suite | 10 files / 188 tests passed | Admission, catalog, Pi lifecycle/environment, streaming and LLM metrics |
| Typecheck / build | Both passed | Main, preload and renderer build; no App installation |

Regression controls: before the Pi fix, three new cases failed on redundant setters. Intentionally restoring eager catalog evaluation made all four direct-admission cases fail; the lazy implementation was restored. These are expected negative controls, not ignored failures. Focused runs exclude the nested `.local` checkout to avoid reporting duplicate suites.

Reproduce from the repository root:

```bash
./node_modules/.bin/vitest bench src/main/context-admission.bench.ts --run --exclude '**/.local/**'
npm run test:unit -- src/main/context-admission.test.ts src/main/app-store.test.ts src/main/providers/pi.test.ts src/main/providers/pi-lifecycle.test.ts src/main/providers/pi-environment.test.ts src/main/trace-output.test.ts src/main/live-trace-ingestion.test.ts src/renderer/turn-stream-projection.test.ts src/main/llm-performance.test.ts src/shared/llm-performance.test.ts --exclude '**/.local/**'
npm run typecheck
npm run build
```

No real account/model requests, renderer first-paint measurement, packaging or installation were performed. These changes reduce preparation work, not measured model TTFT. To attribute remaining delay, compare `SCRY_PERF_LOG=1` admission/launch/first-text checkpoints with Provider request-to-first-block timing and renderer paint under the same model, prompt, history and network. Keep this distinction rather than changing the TTFT clock to make the metric smaller.

## 0.2.173 local installation

The first-output preparation changes from `88935b2` were built in a clean temporary export with an independent dependency copy, avoiding the ignored `.local` checkout. Only the App version changed to 0.2.173; private recorder CLI remains 0.2.47. No real Provider probes were enabled.

- Node 24.18.0: typecheck, full unit suite (206 files / 2,627 tests passed; three opt-in external probes skipped), shell suite, production build, packaged resource checks and packaged Electron security/interaction/file-preview smoke passed.
- CLI release tests passed (32 files / 571 tests). The initial npm 12.2.0 tarball smoke failed on its changed `pack --json` output shape; the unchanged smoke passed with the already-installed npm 10.9.4 via a temporary PATH shim. No global toolchain or test assertions changed.
- The complete renderer UI command did **not** pass. Its first session-capability fixture exited without a result receipt. A diagnostic copy with progress logging then failed the existing terminal-restoration assertion waiting for `/fixture/new/same.ts` in the composer. The cause remains unresolved; no renderer or fixture code was changed for this installation. Credits, chat preview/composer, session performance, background/recovery and steer fixtures were subsequently run individually and passed. These passes do not replace the failed complete UI result.
- After `npm run pack` passed, its exact artifact was installed with the repository's `scripts/install-macos.mjs` transaction. Installed App version, private CLI version and deep/strict signature verification passed. Executable and ASAR compare byte-for-byte with the packaged artifact: SHA-256 `44e7eacfc511dd6c994b2a8d57e10e1a89b815f502715e8490759c2d8aa395c1` and `15a912d492bcfb118369a707fa6b2c5f234565c60a3cf46bdc57c5535e38ffc8` respectively.
- `/Applications/Scry.app` is development-signed, not notarized. The previous 0.2.172 bundle remains at `/Applications/.Scry.app.backup`. The user's running App was not stopped; relaunch is required to use the new code. No installed-App real-model TTFT comparison is claimed.
- Ephemeral logs: `/tmp/scry-0.2.173-{cli-release,cli-package,renderer-ui,ui-diagnostic,remaining-ui,pack,install}.log`.

## Budgets and review rules

Initial budgets, to be adjusted only with same-machine evidence:

- ordinary input/click feedback: p95 <= 100 ms;
- main trace receipt to visible renderer update: p95 <= 100 ms under normal load;
- avoid renderer/main tasks over 50 ms during streaming and history navigation;
- indexed archive page reads and attachment memory should scale with requested page size rather than total archived body size;
- after sessions/runs are released, memory should plateau rather than grow monotonically.

Do not merge an optimization merely because a benchmark is faster. It must also preserve event ordering, evidence quality/provenance, attachment budgets, session identity, archive recovery, database/outbox behavior, Provider differences, and renderer isolation.
