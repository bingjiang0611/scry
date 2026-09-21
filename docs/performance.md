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

## Budgets and review rules

Initial budgets, to be adjusted only with same-machine evidence:

- ordinary input/click feedback: p95 <= 100 ms;
- main trace receipt to visible renderer update: p95 <= 100 ms under normal load;
- avoid renderer/main tasks over 50 ms during streaming and history navigation;
- indexed archive page reads and attachment memory should scale with requested page size rather than total archived body size;
- after sessions/runs are released, memory should plateau rather than grow monotonically.

Do not merge an optimization merely because a benchmark is faster. It must also preserve event ordering, evidence quality/provenance, attachment budgets, session identity, archive recovery, database/outbox behavior, Provider differences, and renderer isolation.
