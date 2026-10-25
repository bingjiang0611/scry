# 2026-10-24 Workflow revision checkpoints and input observations

## Scope and frozen baseline

- The user explicitly chose to retain the complete legacy two-revision acceptance workload and its 5000 ms deadline, and authorized a new focused performance investigation. No timeout, workload, trust or durability relaxation is authorized.
- Scope: remove duplicate persistence of a **completed native result** and input observations that no cache candidate can consume. Scheduling, authorization, native execution, the full disk-backed workloads and historical reuse eligibility are unchanged.
- Measurement-only commits: `313db459`, `1954a228`, `a1510b78` (`scripts/performance-counters/workflow-native.counters.test.ts`). Each collector was measured before its corresponding runtime change. Runtime changes for SystemStep revisions remain separate, uncommitted WIP.
- Frozen pre-optimization runtime: `/tmp/scry-workflow-template-editor.ZnkC6L/m3-quality-perf-before/manifest.json` and the 20 files archived alongside it, based on `6f25d996e179cbabf2c80cd979d1ca5617f4b9bd` plus recorded WIP. This is not the clean committed baseline or a packaged App.
- Full legacy acceptance first failed without instrumentation at load 5.78→5.14 on 10 cores (`m3-quality-native-cache.log`). The first instrumented run was high-load, stopped at seven of eight outcomes and is **not** a comparable full-workload timing baseline (`m3-quality-profile-before.log`).

## Ten perspectives and selection

| Perspective | Idea | Disposition |
| --- | --- | --- |
| Do not do it | Do not write a second byte-identical native result under a frame-specific value key | Selected: existing main ledger already commits its canonical result reference |
| Do it once | Reuse that durable immutable reference, without introducing a cache | Selected implementation mechanism |
| Do it earlier | Prewarm Node or checks | Not attempted; does not remove the duplicate evidence write |
| Do it later | Acknowledge the frame before result/directory durability | Rejected: violates result-before-advance and durable acknowledgment |
| Do it elsewhere | Move persistence or parsing to another worker | Not attempted; architecture change and work still exists |
| Do it cheaper | Investigate repeated executable hashing in check preparation/execution | Unmeasured; cannot omit any trust/fingerprint validation |
| Do it less often | Combine result, ledger and frame transactions | Not attempted; larger persistence protocol change |
| Show it first | Emit progress before all checkpoints finish | Does not meet the unchanged acceptance deadline; cannot pretend completion |
| Change data structures | Avoid repeated native ledger scans | Unmeasured; sampled verification recomputation is not yet shown dominant |
| Change architecture | Store one canonical native fact and reference it from projections | Use the existing canonical fact, not a second fact store or scheduler |

First selected removable work: one redundant flushed native-value file per fresh native result. Follow-up measurements also identified unconsumed revision-admission and ineligible-candidate observations. These L1 reductions do not establish that the remaining map deadline is fixed.

## Measurement and hypothesis

- New diagnostic scenario: `workflow.native-result-checkpoint/io.native-value.writes`.
- Fixed diagnostic workload: one canonical Service/Runner/Interpreter root, one real owned replica of one one-byte file, zero Agent dispatches. Five independent repeats.
- This is a **per-result work counter**, not a smaller replacement for the unchanged eight-SystemStep, two-revision legacy acceptance test.
- Pass-through counter counts completed flushed FileStore writes of main SystemStep envelopes. It calls the production implementation and checks the real result/receipt. A separate sensitivity test adds one real durable write and requires the count to rise by one.
- Before: `[2, 2, 2, 2, 2]`, darwin-arm64 (`m3-quality-native-counter-before.json`). This L1 collection ran concurrently with another checkout's timing owner; no milliseconds from that run are treated as L2 evidence.
- Hypothesis 1: bind the completed frame to the exact canonical `SystemOutcome.resultRef`, after checking the real intent/task/program/kind association and reading/hash-validating the referenced value. Measured after: `[1, 1, 1, 1, 1]` (`m3-quality-native-counter-after.json`).
- Preserve native intent → actual effect → durable result/outcome → durable frame → next effect. Keep normal frame CAS and directory synchronization. Missing/mismatched canonical evidence must reject, not create a replacement fact.
- The counter is collected by the existing scenario discovery, but is **unregistered in the canonical ratchet ledger**. That existing authored JSON file is 22,667 bytes and cannot be edited under the task's 20,000-byte staged-blob limit. Do not minify it, bypass the hook, raise limits or claim a registered baseline. Registering a candidate requires a separate, validated responsibility-based ledger split; this experiment does not undertake that unrelated change.

## Follow-up hypotheses

| Hypothesis | Removed work and preserved evidence | Five-repeat L1 evidence |
| --- | --- | --- |
| 2: observe static admission only when consumed | `prepareWorkflowRevisionReuse` already returns no static selection for dynamic programs. Move the observation after that guard. Dynamic calls still check source at actual consumption; fresh dispatches retain before/after evidence. | Admission calls `[1,1,1,1,1]` → `[0,0,0,0,0]`, `m3-quality-admission-counter-{before,after}.json` |
| 3: observe dynamic candidates only after input/definition match | Candidate matching and canonical frame/output checks precede one fresh observation, shared only within that selection operation. Previously selected facts still recheck source before consumption. A fresh dispatch still records both phases. | Total observation calls `[5,5,5,5,5]` → `[4,4,4,4,4]`, `m3-quality-selection-counter-reviewed-before.json` / `m3-quality-selection-counter-after.json` |

These are separate diagnostic workloads: one one-byte source file, two revisions, production MemoryStore, one map item, and respectively zero or two synthetic settled Provider calls. They count actual pass-through source observations. Sensitivity controls add a real scan and require `+1`. Neither replaces the original real FileStore scenario: three items, three revisions, eleven offline Agent dispatches, unchanged 5000 ms.

Hypothesis 2 frozen runtime: `m3-quality-admission-before/`; hypothesis 3: `m3-quality-selection-before/`. Their `sha256.txt` files identify actual dirty runtime inputs, not just the measurement commits. Paths are relative to the same external evidence directory named above.

## First-round results and handoff (historical)

- Runtime implementations: present, uncommitted. No new cache, deferred writes, ledger refunds, weakened CAS or reduced flush guarantees. Native frames reference an existing durable canonical fact; unconsumed observations are not performed at all.
- Cold native reference identity and actual stale-CAS refusal controls: 2/2 passed (`m3-quality-reference-reviewed-controls.log`). A rejected frame checkpoint leaves its canonical native result readable and dispatches no next Agent.
- Serialized unchanged legacy acceptance: passed at 4078 ms, load 6.41→6.78 on ten cores (`m3-quality-reference-legacy.log`). This is one acceptance run, not a statistical latency improvement or complete App L2/L3 evidence.
- Broad validation after hypothesis 1: 54 files, 515/516 tests passed, 230.67 s, load 8.44→8.44 (`m3-quality-reference-canonical.log`). All new SystemStep and legacy cases passed. The original FileStore map test hit its 5000 ms limit.
- After hypothesis 2, focused map/recovery validation still failed that unchanged limit at load 5.40→5.37 (`m3-quality-admission-map.log`). After hypothesis 3, 18/19 focused tests passed; the same map case still timed out at load 6.07→6.80 (`m3-quality-selection-map.log`). Do not rerun unchanged to obtain green or report complete acceptance.
- Regression control: restoring eager candidate observation makes the new test fail with `before,before,after` instead of `before,after` (`m3-quality-negative-eager-scan.log`). Lazy source restored afterward. The test also binds both retained observations to the actual newly dispatched attempt and verifies both available snapshot envelopes.
- Node and web types passed on the candidate (`m3-quality-selection-{node,web}.log`). Current closeout controls passed4files/32tests in38.46s, load4.55→4.27 (`m3-quality-closeout-controls.log`), including the two native checkpoint tests, all10 SystemStep revision cases,10 dynamic recovery cases and10 ratchet contracts. Unchanged-ledger guard passed. Collector6/6 passed with counts above; its incidental wall time is not L2 evidence.
- L2 speed ratio: unavailable; the initial instrumented baseline was partial/high-load. Full map acceptance remains blocked. Three implementation hypotheses have been attempted in this investigation; stop further optimization and report the remaining deadline rather than silently starting a fourth.
- Canonical ratchet unchanged; new diagnostic metrics remain unregistered, not approved gates. No claim of a tightened ratchet.
- Merge: not merged into a release branch. Build: no optimized artifact. Install/effective App: not installed; daily App untouched. Baseline/candidate packaged build IDs and L3: unavailable/not performed.
- At this handoff, the maintainer needed to decide whether to authorize another bounded map investigation or pause. The maintainer subsequently authorized the second bounded round recorded below; these failures remain evidence, not the current gate result.

## Authorized continuation and current validation

The second round is recorded in [Workflow map stage investigation](20261024-workflow-map-stage-profile.md). It removed twelve intermediate parent publications from the complete original workload without moving work past acknowledgement. Current Workflow selection:56files/537tests passed; original map3737ms under its unchanged5000ms (`m3-map-sequence-canonical.log`). This closes the map gate for that source/environment, not a general latency distribution.

Full Node unit:335files/3982tests passed,4 credential/correlation opt-in cases skipped (`m3-quality-all-unit.log`); highLoad=true means its709.41s is not a benchmark. Current production build, isolated Electron ownership/conversation IPC and Chromium Workflow UI smoke passed (`m3-quality-production.log`, `m3-quality-ui.log`). The IPC exercise uses offline Providers and the existing entrypoints; it does not prove new revision IPC/UI, real accounts or M1–M6 completion. No install, push or daily-App restart occurred. The mapped `providers.catalog` measure still reports no matching collector (`m3-quality-performance.log`), not zero or pass. The unregistered diagnostic counters above do not close that separate gap.
