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

## Budgets and review rules

Initial budgets, to be adjusted only with same-machine evidence:

- ordinary input/click feedback: p95 <= 100 ms;
- main trace receipt to visible renderer update: p95 <= 100 ms under normal load;
- avoid renderer/main tasks over 50 ms during streaming and history navigation;
- indexed archive page reads and attachment memory should scale with requested page size rather than total archived body size;
- after sessions/runs are released, memory should plateau rather than grow monotonically.

Do not merge an optimization merely because a benchmark is faster. It must also preserve event ordering, evidence quality/provenance, attachment budgets, session identity, archive recovery, database/outbox behavior, Provider differences, and renderer isolation.
