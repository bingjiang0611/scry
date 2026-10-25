# 2026-10-24 Workflow map stage investigation

## Authorization and baseline

The maintainer authorized another bounded round (at most three experiments), starting with stage timing and I/O. Keep the original three-item, three-revision, eleven-offline-Agent FileStore workload and its 5000 ms deadline. No new functionality, caching architecture, trust relaxation or durability weakening is authorized.

Baseline: `a1510b78e303daef9d798984dbf955b0dc056278` plus the 24-file dirty-source snapshot `/tmp/scry-workflow-template-editor.ZnkC6L/m3-quality-closeout-source.json`. This includes the prior native-reference and unused-observation changes, not a clean committed App build.

## Experiment 1: measure before selecting another implementation

External pass-through instrumentation: `m3-map-stage-profile.mjs` and `.config.mjs` in the same evidence directory. It wraps actual asynchronous methods and filesystem calls, preserving arguments/results/errors and the configured deadline. Base `vitest.config.ts` has no setupFiles to omit. No test body, workload or product source changed for this diagnostic.

- `m3-map-stage-profile.log`: complete=true, all three Runner stages finished, canonical root completed with eleven intents and eleven outcomes. One selected original test passed in3890ms; five adjacent cases were intentionally filtered, not disabled.
- Serialized timing: ten cores, load5.64→5.99, highLoad=false. Earlier uninstrumented 5000ms failures remain recorded. A passing instrumented sample is not proof of stable latency or a speed ratio.
- Actual completed atomic publications:282; directory synchronizations:244. These include planning and all three roots. The prior recorded same-workload289/251 was before removing seven unused observation headers; do not treat that older external count as an independently registered ratchet baseline.
- Inclusive atomic-write time across stages:2547.62ms (935.47+758.59+789.18+64.38). Nested inclusive method durations must not be added together. Directory sync time:1050.34ms; writeFile time includes requested file flushes. Reads via FileHandle are not all represented by the separate fs.readFile counter.
- Each root performs ten parent-sequence cursor publications. `control.advanceSequence` costs about157–170ms per root. Some cursor publications are immediately followed by completion of that same parent, with no further interpreter effect between them.

## Ten perspectives

| Perspective | Candidate | Decision |
| --- | --- | --- |
| Do not do it | Omit the intermediate parent cursor publication when the successful last child is immediately followed by parent completion | Measure a narrow candidate; publish child link/cursor and parent result together before acknowledgement |
| Do it once | Avoid reading the same historical source twice within one selection | Smaller read-time opportunity; not selected before measuring the dominant writes |
| Do it earlier | Prewarm filesystem metadata or Provider processes | Not selected; architecture permission and no proof that startup dominates |
| Do it later | Acknowledge before directory sync | Rejected: violates durable acknowledgement |
| Do it elsewhere | Worker/process persistence | Not selected; work remains and requires architecture approval |
| Do it cheaper | Remove lock-file fsync | Rejected in this scope; do not weaken existing persistence/ownership guarantees |
| Do it less often | Consolidate parent completion and final cursor checkpoint | Selected mechanism using existing frame/value checkpoint and CAS |
| Show it first | Announce completed before result convergence | Rejected: false completion does not meet the gate |
| Change algorithm | Index historical candidates | Unmeasured smaller opportunity; no new cache approved |
| Change architecture | Transactional root-ledger/frame bundles | Larger cross-boundary change; not selected |

## Experiment 2: consolidate only the terminal sequence checkpoint

Implemented in `workflow-frames.ts`, `workflow-control.ts` and `workflow-interpreter.ts`. A successful final child yields an unpublished parent cursor/child-link draft. Existing immediate parent completion publishes that draft and its result with the same CAS, both file flushes and final directory sync before acknowledgement. No subsequent effect intervenes. Non-final, failure and stopped paths retain their earlier publication boundaries.

Measurement-only commit `9c294bb5ce6c357d7c466127a30a6814d4289dfa` preceded the runtime edit. Its real FileStore diagnostic (literal binding plus return, zero Agents) reads back the cold final value and both child references. Five repeats: parent publications `[4,4,4,4,4]` → `[3,3,3,3,3]` (`m3-map-sequence-counter-reviewed-before.json`, `m3-map-sequence-counter-after.json`). Sensitivity adds a real CAS-valid publication and requires+1. This diagnostic does not replace the original map gate.

Four new `workflow-sequence-checkpoint.test.ts` cases prove final child retention, real stale-CAS refusal, cold-controller resume without a second Agent attempt, and held/failing real directory synchronization without early acknowledgement. Recovery creates a new generation and retains the old entered parent unchanged. Together with existing bundled-checkpoint tests:7/7 passed (`m3-map-sequence-reviewed-controls.log`). Restoring the extra final cursor publication makes the new regression fail (`m3-map-sequence-negative-publication.log`); candidate source was restored byte-identically.

The complete matched profile after this change (`m3-map-stage-profile-after.log`) still has all3 revisions and11 intents/outcomes, root completed. Atomic publications282→270; directory sync244→232; handle sync164→152; `advanceSequence`30→18. These twelve publications were deleted, not deferred or moved to uncounted work. Directory-sync total time was1050.34→1050.96ms despite fewer calls: storage latency varies. Single selected before/after samples3890→3780ms, loads5.64→5.99 versus8.45→7.93 on10cores, both highLoad=false. This is bounded L1 evidence plus one observed L2 pair, not a stable speed ratio, p50/p95 or App/L3 claim. The pre-edit three-file snapshot is `m3-map-sequence-before/sha256.txt`.

## Delivery

| Check | Result | Evidence |
| --- | --- | --- |
| Workflow selection |56files/537tests passed; original three-revision/eleven-call map3737ms, original5000ms unchanged;10cores/load6.56→7.65, highLoad=false | `m3-map-sequence-canonical.log` |
| Focused unchanged map/recovery |3files/23tests passed; map3547ms | `m3-map-sequence-focused.log` |
| Node/web types | Passed | `m3-map-sequence-reviewed-node.log`, `m3-map-sequence-web.log` |
| Full Node unit |335files/3982tests passed;4 credential/correlation opt-in tests skipped; highLoad=true, no timing conclusion | `m3-quality-all-unit.log` |
| Current build and isolated production IPC | Passed; real local checks and offline Providers; existing entrypoints only | `m3-quality-production.log` |
| Isolated Chromium Workflow UI | Passed; existing entrypoints, not a new revision UI | `m3-quality-ui.log` |

Canonical ratchet is unchanged; diagnostic metrics remain unregistered while the authored-ledger size constraint is unresolved. `performance:measure -- --scenario providers.catalog` still reports no collector (`m3-quality-performance.log`); do not present that gap as zero/pass. No deadlines, workload or assertions were weakened. Earlier failures in the first investigation remain recorded in [the native checkpoint record](20261024-workflow-native-checkpoint.md).

No install, push, daily-App restart, baseline/candidate package comparison or L3 measurement occurred. Cold checkpoint checks use fresh stores/controllers in-process, not real OS-process recovery. Revision IPC/UI, full quality programs and M1–M6 remain separate unfinished scope. This completes two experiments in the newly authorized three-experiment budget; no third is needed for the now-passing map gate. Parent next records the exact source/commit and archives the evidence before continuing the already-authorized implementation backlog.
