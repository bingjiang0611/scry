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
- Command: `SCRY_IOS_CHECK_SIGN_IDENTITY=<local development identity> python3 apps/ios/Checks/catalog-refresh.py --check observation`.
- Runner compiles the actual store, AppModel and coordinator plus a same-file fixture. No production setter is widened. It drives the real generation/identity-checked `append`, with 200 distinct output sequences, one active Pi session, no transport, isolated preferences and temporary directories. Probes rearm before each mutation. Existing catalog runner and production view-model extraction are reused.
- Baseline counts: stream/catalog/projects/providers/history/lifecycle/questions/homeSessions = 200 each; appLink = 0. Output coalesces to exactly one 200-character row.
- Sensitivity: same baseline with `--require-isolation` fails `observation.invalidationContract` (exit 1), while output, lifecycle/question visibility and repeated catalog projection checks pass.
- The baseline harness initially failed compilation (wrong fixture property names / constructing a wire-only chunk), then failed cleanup because the unused directory did not exist. Corrected before accepting the baseline; no production changes or retries concealing a failed product check.
- Host: Apple Silicon macOS, Xcode 26.6 (17F113), Swift 6.3.3 compiler / Swift 5 language mode. Counts only, no millisecond benchmark. Existing Swift concurrency / unnecessary-await warnings are not new test failures.

## Delivery and results

- Optimization source: pending.
- L1 candidate: pending. Native dependency probes are outside the performance ratchet; no gate/baseline changes.
- L2: unverified; no latency claim. Real-device interaction checks pending.
- L3: unverified; no deployment/day-to-day sample comparison.
- Integration: not merged to main; F branch only.
- Build: pending isolated iOS device build. No desktop build requested.
- Install/effect: no daily App installation/overwrite; isolated fixture only, if built.
- Daily comparison: unavailable; no candidate daily build mapping.
- Where work goes: unrelated notifications are eliminated, not delayed or moved off the counter.
- Next owner/action: F author completes migration, focused checks and available physical-device fixture checks; integrator reviews branch evidence before updating verification status.
