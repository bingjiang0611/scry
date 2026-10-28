# Captured workflow task observation checkpoint

This checkpoint adds bounded task browsing and reopening. It is not complete M2 or M1–M6 delivery. The native Claude CLI remains excluded by the user, not verified.

## Implemented boundary

- `ConversationTaskStore.listWorkflowTasks()` reads existing App-owned submission headers. It returns at most ten records per page, in submission-hash order, not creation order. It scans at most 8,192 directory entries, including input directories. Exceeding that bound produces an explicit error without deleting records or restricting intake. A paged directory index is required before raising this browsing limit.
- Version 1 direct submissions are not workflow tasks. A page may therefore be empty and still contain a next cursor. Concurrent insertion before the cursor appears on refresh; pages are observations, not a globally frozen snapshot.
- Inspection reads and verifies the complete immutable version 2 input. Current workflow intake is bounded to 16,000 characters; one integrity-checked 256 KiB content page is sufficient. Clipped, corrupted, mixed-version or missing data fails closed.
- Trusted `workflow:capturedTasks` and `workflow:inspectTask` handlers accept only lookup identities. The existing controller revalidates the conversation and canonical project authority. Renderer paths, source claims, callbacks, native keys and planning configuration are not read authority.
- `observeCapturedPlanning()` reuses the existing canonical-root correlation predicate: matching request digest, settled planning scope, recorded provider result, canonical root, frozen size and program validation. It does not invoke a planner, publish an association, change a journal or reopen an unknown dispatch fence.
- The conversation toolbar loads tasks only when explicitly opened. It shows intake status and read time, not a fabricated live execution result. Inspection exposes the original submission and frozen size. An eligible current-instance capture can reopen configuration; a proven existing candidate can reopen its concrete approval dialog. Completed/running roots are read-only in this inspector. Unknown task intake remains visibly unknown even when a settled candidate is available.
- Pagination, retained prior pages on read failure, conversation/unmount generation fences, keyboard entry/return focus and narrow desktop wrapping use the existing UI system. Reopening does not itself submit, plan, approve or start an Agent.

The existing sixteen controller test bodies remain byte-identical after moving their shared synthetic setup into `workflow-task-planning.fixture.ts`. There is still one Store, admission owner, WorkflowService and execution chain.

## Verification

Logs are under `/tmp/scry-workflow-task-entry.V7ObQf/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web types and focused unit contracts | 20 files, 281 tests pass | `workflow-task-observation-final-gates.log` |
| New observation tests | Seven cases: raw input, bounded paging, cold known root/unknown fence, missing or unsettled evidence, old-owner/archive, corrupt content and directory bound | `workflow-task-observation.test.ts` |
| Guard negative control | Removing the settled-scope predicate exposes a preview and fails the focused regression; production text restored exactly | `workflow-task-observation-scope-negative.log` |
| Real React/Electron input | Existing command workload plus task configuration, read-only completed root, known preview reopening, paging/error retention, stale conversation response and row-focus restoration pass | `workflow-task-observation-focus-return-fixed.log` |
| Adjacent readback | All six original request/lifecycle scenarios pass | `workflow-task-observation-final-gates.log` |
| Classic workflow UI and build | Original planning/approval/stop/rehydration workload passes; build and diff check pass | `workflow-task-observation-classic-remount-fixed.log`, later current build in `workflow-task-observation-focus-return-fixed.log` |
| Actual preload/Main/FileStore | Five original synthetic Provider calls total; task observation adds zero calls and leaves five canonical evidence files byte-identical | `workflow-task-observation-final-app.log` |
| Existing counter workload | Eight tests pass; five parent-publication samples are all 3 | `workflow-task-observation-counter/measure.json` |

The counter row is **unregistered**. Global ratchet success is not an enforced numeric threshold, total-I/O equivalence or speed proof. No baseline comparison or profiler was used. Native identity I/O is not measured by this counter.

The actual App scene is `scry-electron-smoke-13MS2u`, with isolated HOME/userData and synthetic workspace. It retains the prior six ownership refusals, positive legacy operations, direct task deduplication, native-scope fence, late dispatch refusal, canonical planning result, cold receipt observation and failed-startup rejection. The new read-only check also injects an unsettled planning receipt, verifies that no candidate is exposed, then restores the exact pre-injection bytes. This is state injection, not a filesystem crash or real SDK test.

Pre-run `workflow-task-observation-final-app-identities.json` binds 77 source files and all 16 built files. Main SHA-256: `a2936dd274b656903c09deb07803ffe4ad62b711055ceadb03bd15755f8aafd2`; preload: `3f623dabc956c53fb6f9cdce5260d062e0822bcbff2c818438f4c0eb57b6dac5`. UI/scripted bridge and actual Main/FakeProvider are separate scenarios, not one real Provider UI end-to-end test. Registered cleanup helper return is not escaped-descendant or remote-effect closure proof.

## First failures retained

- The first Node check after fixture extraction found two missing `mkdir` imports. The first new widget typecheck found incorrect existing-component prop shapes. Both were corrected without changing their contracts.
- The first UI run could not focus a disabled loading button. A later stronger row-return assertion exposed that disabling a row before modal mounting loses its native focus identity. The component now restores the explicitly captured trigger after the read/modal completes. Both failed scenes and diagnostics are retained.
- The first expanded unit run had 280 pass and one test assertion error: the strict reference parser throws synchronously, so its negative assertion must use `toThrow`, not promise rejection. The forged-field rejection assertion and privileged-listener checks remain.
- The first expanded UI gate failed the old classic size selector after fixture rehydration. Its old readiness condition could already be true on the retiring dialog. The fixture now additionally waits until the original select is disconnected before sending the same native input. All original assertions, selections, workload and deadlines remain. The original failing output is retained; its runner deleted that temporary scene in its original `finally`, so missing state was not reconstructed.
- The intentional settled-scope negative fails as expected; six other tests are command-filtered for that control, not permanently skipped.

No failure is attributed to machine load. Historical SystemStep/recovery/TAP/unified/dynamic-revision deadline failures remain open, not reclassified or erased by these passes.

## Remaining work

This reader covers captured version 2 chat workflow submissions, not all standalone/template/native tasks or a complete workflow graph/history product. Intake phases are not execution phases. Unknown or old-instance captures are not automatically retried. Full manual/auto policy, billing-account/data-fee consent, combined route-and-plan, other command dispatch, same-root reconfiguration UX, remaining M3–M6 acceptance and release gates remain open. `src/main/index.ts` is still over the authored-file size limit. No commit, push, installation, version bump or daily-App restart was performed.
