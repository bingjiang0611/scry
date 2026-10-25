# Same-root revision: production review and approval entry

This increment exposes an existing same-root revision operation through the production preload/main boundary and an explicit desktop review. It is **not complete M3 or M1–M6 delivery**. Generic failed/stopped restart, per-node control, automatic stall recovery and the full quality programs remain separate work.

## Authority and behavior

- `WorkflowApi.prepareRevision` accepts only workflow ID, expected state revision, user goal, editable role bindings and program body. Main reloads the canonical root, checks recovery and the expected state revision, resolves current runtime capabilities, compiles the body and refreezes native authorization.
- Renderer cannot supply workspace authority, runtime identity, a frozen preview or a native execution grant. Existing native authorization in editable source is removed and independently reconstructed by main.
- Main retains at most 32 prepared candidates. The candidate binds its program hash to its expected state revision. The returned review object is a copy; changing it cannot change the main candidate.
- `WorkflowApi.revise` submits only root identity, approval, expected state revision and command ID. It enters the same Service → Runner → Interpreter → main effect adapter chain. No second scheduler was added.
- The UI first prepares and displays the complete frozen program, native plan and existing budget/cost notices. Execution requires a separate explicit confirmation. Invalid JSON, preparation, closing review and Escape do not execute the candidate.
- A command keeps the same approval timestamp and command ID on a manual retransmission. An accepted durable command resolves through immutable revision history after an App restart without redispatch or replacing the current in-memory approval.
- An unaccepted memory-only candidate is unavailable after eviction or restart. The user must prepare and review again. Main does not reconstruct an unapproved candidate from renderer data.
- Editing a template-instantiated run creates a standalone governing program. The original frozen template remains in historical revisions. This does not edit or publish that template.
- Prior intents, outcomes, system boundaries, root budgets and unsettled/unknown restrictions remain authoritative. Preparing a candidate does not change the durable root.

The terminal-state action is **修订并继续**. This is not a generic permission to replay a failed Provider call. Existing recovery/revision checks can still reject an unsafe unchanged call or historical unknown execution.

## Implementation

- Contracts and source-only validation: `src/shared/workflow-api.ts`, `src/shared/workflow-source.ts`, `src/main/workflow-revision-draft.ts`.
- Main candidate admission and durable duplicate handling: `src/main/workflow-service-revisions.ts`.
- Trusted registrations: `workflow:prepareRevision` and `workflow:revise` in `src/main/workflow-ipc.ts`.
- Fixed preload bridges: `src/preload/workflow-api.ts`; unchanged Agent bridge behavior was extracted to `src/preload/agent-api.ts` so authored files respect the repository's 20,000-byte cap.
- Review UI: `WorkflowRevisionEditor.tsx`, shared `WorkflowSystemPlan.tsx`, `workflow-revision-editor.ts`, existing modal/focus behavior and centralized copy.
- Native cold-path work reductions are documented separately in [the experiment record](../../docs/performance-experiments/20261025-workflow-native-recovery.md). They do not relax hash validation, process closure or durable acknowledgement.

## Current-source acceptance

The local evidence archive is `/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-m3-revision-entry.liXjHv`; it retains exact source blobs, full logs, captured build hashes and production screenshots. Checksums provide local integrity, not signatures or external execution receipts. Original logs also remain under `/tmp/scry-workflow-template-editor.ZnkC6L/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Full Node unit | 344 files, 4007 tests passed; four opt-in files/tests skipped | `m3-revision-entry-store-scope-full.log` |
| Node and web types | Passed | `m3-revision-entry-final-node.log`, `m3-revision-entry-final-web.log` |
| Production build | Passed | `m3-revision-entry-final-build.log` |
| Production Chromium/Electron input and review | Passed; trusted pointer/keyboard, invalid source without effects, complete review, 480px layout, focus containment/restoration, Escape without execution | `m3-revision-entry-final-ui.log` |
| Actual revision execution through production IPC | Passed; same root, three revisions, three fresh native copies/checks, zero Agent attempts in the revision case | `m3-revision-entry-final-ui.log` |
| Actual App-process restart | Passed; accepted revision duplicate did not dispatch; canonical history unchanged | `m3-revision-entry-final-cold.log` |
| Main sender/frame/origin and workspace rejection | Passed in the full unit selection, including both new channels | `src/main/workflow-ipc.test.ts` |
| Old approval mutation control | Deliberately restoring approval on accepted retransmission fails the new regression | `m3-revision-approval-negative.log` |
| Mechanical bridge/process extraction | TypeScript-printed bodies retain 70 Agent properties, 14 existing Workflow properties and three extracted process functions; not a complete-file/runtime equivalence claim | `m3-revision-entry-extraction-check.json` |
| Official mapped performance scenario | Unavailable: no matching `providers.catalog` collector | `m3-revision-entry-performance.log` |

The production conversation fixture also exercised its existing **offline** Provider paths. Its aggregate Provider-invocation count is not zero and is not real account usage. The new revision cases themselves have zero Agent attempts and execute real local Node native checks only. Successful fixtures use temporary workspace/userData; no business workspace or daily App is involved.

The whole-unit timing record has `highLoad=true` (load 4.46→16.89 on 10 cores). Native positive/negative OS-controller cases passed at 4054/3370ms, and the unchanged map workload at 3895ms, each under its original 5000ms deadline. These are acceptance observations, **not** stable p50/p95, a controlled speedup, an App latency claim or L3 daily-use evidence.

## Failures retained, not erased

- The first complete unit run had 3995 passing tests and one original native-process positive timeout. An earlier 600s tool deadline also left an incomplete full run; no complete-suite result is claimed for it.
- Later high-load focused runs retained original 5000ms timeouts in native positive/negative cases and an original loop-recovery case. No test deadline or workload was changed. After real cold-artifact, fingerprint-stream and group-absence changes, the full current-source run above passed. It does not prove stability under arbitrary machine contention.
- A new failed-load cache test initially expected artifact republishing after `save`; that expectation ignored `save`'s valid re-read under the root lock. The corrected test directly proves a rejected root never calls `rememberOutput`, then verifies the subsequent valid read and unchanged durable history. Moving cache admission before full root validation makes it fail.
- Initial production fixture assertions incorrectly expected inline governing previews and counted check-context replica references as new materializations. They now read/hash the actual immutable governing references and join materializations to `prepare_replica` intents. The real workload and required outcomes were retained.

## Remaining work

This increment does not establish generic restart eligibility for settled failures/stops, stage stall/fail-fast controls, all six quality programs, trustworthy test denominators/coverage, production Jev/apply authorization, output/graph management, all-Provider parity, real accounts/billing or complete M6 acceptance. Existing [M1–M6 delivery obligations](m1-m6-delivery.md) remain open. No release, installation, push, daily-App restart or new real Provider/Jev call was performed.
