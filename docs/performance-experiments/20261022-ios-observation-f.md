# 2026-10-22 · F · iOS property observation

## Contract and hypothesis

Keep transport, run state, questions, delivery uncertainty, recovery, cache authority and drafts unchanged. Migrate iOS 17+ store/view observation, not provider behavior. At `bf92d04`, 200 accepted output fragments invalidate each store subscriber 200 times; `ExecutionTargetCoordinator` also forwards every selected/new-task store change. `AppModel` does **not** forward these notifications (its link probe is already 0).

Hypothesis: property tracking keeps the output dependency at 200 invalidations while catalog/projects/providers/history/lifecycle/questions/home-session dependencies fall from 200 to 0; AppModel link stays 0. These are **native dependency invalidations, not SwiftUI body evaluations or elapsed time**. No latency/energy claim follows from this count alone.

## Alternatives considered

| Perspective | Option / decision |
| --- | --- |
| Do not do | Stop notifying unrelated dependencies: selected. |
| Once | Cache rendered output: rejected; not the notification root cause. |
| Ahead | Prebuild view trees: no evidence of benefit here. |
| Later | Delay notifications: rejected; may delay questions and lifecycle. |
| Elsewhere | Move observation to another actor: UI state belongs on MainActor. |
| Cheaper | iOS 17 native Observation: selected; no new dependency. |
| Fewer | Batch output: existing coalescing retained; do not weaken event visibility. |
| First display | Cached content: orthogonal; retain cache evidence semantics. |
| Structure | Split dozens of stores: more routing/identity complexity than native property tracking. |
| Architecture | Rewrite transport/view projection: unnecessary; retain the existing state machine. |

## Fixed workload and evidence

- Source baseline: `bf92d04`; measurement-only commit recorded in reports/F.md.
- Command: `python3 apps/ios/Checks/catalog-refresh.py --check observation --require-isolation` (baseline collection omits `--require-isolation`; its negative control includes it). The initial baseline used the runner's optional local development signing identity; final checks use its default explicit ad-hoc signature.
- Runner compiles the actual store, AppModel and coordinator plus a same-file fixture. No production setter is widened. It drives the real generation/identity-checked `append`, with 200 distinct output sequences, one active Pi session, no transport, isolated preferences and temporary directories. Invalidated probes rearm before the next mutation; still-armed dependencies are retained. Existing catalog runner and production view-model extraction are reused.
- Baseline counts: stream/catalog/projects/providers/history/lifecycle/questions/homeSessions = 200 each; appLink = 0. Output coalesces to exactly one 200-character row.
- Sensitivity: same baseline with `--require-isolation` fails `observation.invalidationContract` (exit 1), while output, lifecycle/question visibility and repeated catalog projection checks pass.
- The baseline harness initially failed compilation (wrong fixture property names / constructing a wire-only chunk), then failed cleanup because the unused directory did not exist. Corrected before accepting the baseline; no production changes or retries concealing a failed product check.
- Host: arm64 macOS 27.2, Xcode 26.6 (17F113), Swift 6.3.3 compiler / Swift 5 language mode. Counts only, no millisecond benchmark. Existing Swift concurrency / unnecessary-await warnings are not new test failures.

## Delivery and results

- Measurement commits: `fae1993` (baseline and negative control), `6eb43e8` (mixed observation probes and four additional dependency regressions).
- Optimization source: `82c5b33ba3f1375fe25862a74688472719e5e2b8`. Store and coordinator migrate; AppModel stays unchanged. It does not subscribe to the stream and still owns low-frequency pairing/navigation/drafts, including persisted-connection-derived UI state. No parallel connection cache was introduced.
- L1 candidate: stream 200→200; catalog/projects/providers/history/lifecycle/questions/homeSessions each 200→0; appLink 0→0. Eight focused assertions pass, including output integrity, questions/lifecycle, repeated catalog projection, nested pending-work, stop, history and private readiness tracking. These are dependency probes, not full-view instrumentation. Outside the ratchet; no gate/baseline changes.
- Other checks: metadata task key 7/7; Swift transport package 67/67. Catalog/store suite 142/146: exact same four failures and all 146 results on old source and candidate. See [F report](../handoff/perf-2026-10-22/reports/F.md) for names and scope. No existing assertions weakened or skipped.
- `performance:measure --scenario remote.loopback` cannot collect: `No counter collector matches remote.loopback`. This mapped path lacks a counter collector; no `better`/`worse` result is available from it. The native counts above are the F evidence.
- L2: unverified. iCTRL connected to an iPhone 13 / iOS 26.5.2, but isolated installation failed because all three free-development app slots are occupied. No body/frame/hitch/500+ line measurement or phone UI acceptance. No simulator substituted.
- L3: unverified; no deployment/day-to-day sample comparison.
- Integration: not merged to main; F branch only.
- Build: repository-source Debug `build-for-testing` succeeds for generic physical iOS (App + XCTest UI target), unsigned and not executed. Final source `82c5b33`, version `0.1.15 (24)`; `ScryRemote.debug.dylib` SHA-256 `734a1ca208069ed6ec4979738c590d23ffb5d499de05d4c747c01bfcdc910ea5`. iOS has no embedded full Scry build ID: unavailable. A separate signed preview-only fixture was built with a cached test profile, but cannot install. No desktop build requested.
- Install/effect: not installed. Daily App, its pairing and data untouched; no version bump. The signed fixture is not a daily candidate build.
- Daily comparison: unavailable; no installed candidate build or daily sample mapping.
- Environment failures preserved: an initial build was interrupted; incremental compilation then succeeded. A new test bundle had no provisioning profile/account; a cached test-only ID compiled after correcting command-wide manual-profile settings. Its install was then rejected by the device quota. Later CMS-signed native tests were killed with signal 9 despite valid signatures; the retained identical binary passed after the runner-supported ad-hoc signing, and the final normal runner passed with its default signature. No security policy changes or automatic retry loop.
- Where work goes: unrelated notifications are eliminated, not delayed or moved off the counter.
- Next owner/action: integrator reviews source and unchanged catalog failures before merge; device owner authorizes/provides an available development slot or another iCTRL phone, then F owner replays the required phone scenarios, `-selfTest`, UI target and serial hitch/body measurements. Until then F remains 待核验.
