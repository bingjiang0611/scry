# Captured workflow: authoring identity fence

This is a partial M2 checkpoint. It does not complete M1–M6 or establish a billing-account authorization contract.

## Implemented boundary

- A newly configured captured chat task reads the orchestrator's existing opaque native continuation identity before claiming planning dispatch. Main checks the adapter's explicit authoring declaration first and uses the existing provider-operation/authentication mutex.
- The same atomic task intent stores that identity with the planning-request hash. The private planning fingerprint, service callback, App options and existing Provider request carry it. Renderer payloads cannot supply it.
- Immediately before Provider entry, Main re-reads the native identity under the existing start-operation lease. It then checks the latest task/workspace fence last, before dispatch markers and `ProviderRegistry.run()`.
- The Claude adapter receives the existing `expectedContinuationKey` contract and retains its own actual-runtime environment check. No second identity parser, SDK loop, scheduler or account API was added.
- Association and unknown transitions preserve the original identity. Cold observation uses the recorded identity and does not query or replace it with the current account's value. Legacy records without this evidence remain without it.

The identity describes the existing transport/auth-source contract. It is not a permission token, readable account label, proof of the billed account, or authorization for worker execution. This change only fences planning for captured chat tasks. Standalone/template planning and approved worker execution are not newly account-bound here.

## Verification

Environment: macOS arm64, repository `c9386b60` plus current WIP. No real Provider, Native CLI, account or paid model was invoked.

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web types, focused regressions and build | 19 files, 271 tests passed; build passed | `workflow-task-auth-lease-gates.log` |
| Cold and late-identity service regressions | Original identity survives association/unknown; cold observation does not query current identity; changed scope admits zero synthetic Provider entries | `desktop-workflow-task-entry.test.ts` |
| Actual Main negative control | Disabling only the comparison produced one additional synthetic Provider call and a candidate; unchanged fixture correctly failed | `workflow-task-auth-guard-negative.log`, retained scene `scry-electron-smoke-V1lv8A` |
| Current isolated App | Actual preload/Main IPC and FileStore; changed scope produced zero additional adapter calls; unknown fence and cold bytes stayed unchanged | `workflow-task-auth-lease-app.log`, scene `scry-electron-smoke-vQdivX` |
| Existing counter | Eight collector tests passed; parent publications `[3,3,3,3,3]` | `workflow-task-auth-lease-counter/measure.json` |

The counter row is **unregistered**. There is no enforced numeric gate, baseline comparison or profiling result. It does not measure identity-read IO or establish a speed improvement. Timing metadata reported `highLoad=false`; no causal or latency conclusion is drawn.

The current App still performed the original five synthetic adapter calls: fork, legacy run, two direct tasks and one successful planning call. The added identity-rejection case performed zero calls. Existing ownership refusals, direct duplicate/late-fence checks, frozen-size behavior, recorder exclusion, approval-before-workers, cold failure and planning-receipt observation assertions remain in the workload. The generated workers were not started. Canonical output provenance is `scry_fixture_success_result`, not SDK evidence.

Current pre-run manifest: `workflow-task-auth-lease-app-identities.json` (71 source hashes, all 16 build files). Main SHA-256: `b4d2e4334e96cdded699f0690e67c65d713ee7d7d05cf4d26aa9a4d40621e1f0`; preload: `cb1a30b8908c6bbb4544dc06e64a3812c41f64d42b4309f3aaffc222539bb58a`.

## Preserved failures and limits

- The first type check found a wrong `ProviderContext` import; it was corrected to the existing shared export. The original failed log is retained.
- The negative control's actual source and all 16 compiled artifacts were copied before restoration. The helper was restored byte-identically. Later positive-only changes add unsupported-provider rejection and the initial lookup's operation lease; the final App is not claimed to differ from that negative build by only one line.
- The added fixture was bounded using its existing 15-second limit. It uses an event gate, not polling or a larger deadline. On failure, the original owned-App cleanup remains responsible for registered resources. Cleanup return does not prove escaped-descendant or remote-effect closure.
- The existing native identity implementations can perform synchronous auth/settings reads. This change reuses their authority rather than adding another parser/cache. Snapshot and pre-effect reads are intentional; their latency was not measured. An asynchronous replacement must preserve actual runtime identity and failure semantics.
- Native SDK enforcement remains unverified. Claude CLI validation is explicitly excluded by the user, not passed. Configuration tests and the synthetic App do not prove disabled host tools on a real Native runtime.
- The earlier SystemStep/recovery/TAP/unified and dynamic-revision deadline failures remain open. No timeout, workload, ratchet or assertion was relaxed. Known unavailable collectors remain unavailable, not zero/pass.

## Remaining work

Parent continues M2: account/data/fee authorization, per-conversation off/manual/auto policy, one combined route/plan call, remaining intake/command paths and task UI. These require explicit Provider differences; an opaque continuation key alone must not be promoted into billing-account proof. M3–M6 open work and the oversized Main entry point remain tracked by the preceding status documents.

No staging, commit, push, installation, version bump, daily-App restart or business-workspace write was performed. Earlier frozen archives are unchanged.
