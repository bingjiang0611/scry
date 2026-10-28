# Planning receipt reconciliation — partial M2

This checkpoint closes the committed-root / lost-planning-acknowledgement gap. It does not implement the remaining chat-to-workflow TaskSubmission handoff or complete M1–M6.

## Canonical evidence

- Planning admission writes `planningRequestHash` in the same root publication as the validated candidate. The hash correlates the exact Main planning request; it is not execution approval, account authority or a second receipt ledger.
- Existing roots cannot acquire, replace or delete this evidence. Legacy roots remain without it. The canonical Runner preserves it when claiming execution.
- After a planning error, observation may return the existing canonical preview only when the exact request, settled planning scope, recorded result, frozen size and root correlation agree. Compiler/frozen-preview checks still apply.
- Observation does not invoke the planner, rewrite the failed planning intent, release an unknown scope, reset budgets or approve execution. Missing/mismatched evidence remains fenced.
- A root with a missing planning intent cannot trigger another planner call. This adds one necessary root lookup before publishing a new planning identity; the bounded counter below does not measure total IO.

## Verification

Evidence root: `/tmp/scry-workflow-task-entry.V7ObQf/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Focused current source | Node/web types, 7 files / 101 tests, build and diff check pass | `planning-receipt-orphan-fixed.log` |
| Real temporary FileStore and MemoryStore | 16 new cases: lost completion write, lost root ACK, live/cold observation, immutable correlation, legacy refusal, unknown-slot retention, Runner claim, missing intent and failed root publication | `src/main/workflow-planning-receipt.test.ts` |
| Old implementation controls | Valid lost-ACK cases failed before the fix; missing-intent controls failed because the old implementation replanned | `planning-receipt-valid-negative.log`, `planning-missing-intent-live-negative.log` |
| Current production preload/Main IPC | Existing synthetic Provider workload passes; cold concurrent receipt observation returns the same root/revision with zero additional Provider calls | `planning-receipt-orphan-app.log` |
| Existing bounded counter | 8 tests pass; parent-frame publications `[3,3,3,3,3]` | `planning-receipt-orphan-counter/measure.json` |

The counter row is **unregistered**. The collector's overall ratchet result is true, but this row has no enforced numeric gate. No baseline comparison, profiler, workload change, speed improvement or total-IO equivalence is claimed.

The App case uses `scry_fixture_success_result`, not genuine SDK output. Its original ownership, direct-task, late-dispatch fence and cold-start checks remain. Two concurrent initial planning requests produce one synthetic planning call and zero worker dispatches. The fixture then saves the original completed intent bytes, injects a failed-but-settled receipt state, and verifies that both recovery requests leave the root, candidate and failed receipt bytes unchanged. The App test simulates receipt state; actual write/ACK failures are injected in the real FileStore unit cases.

Current pre-run identity: `planning-receipt-orphan-app-identities.json` (61 source files and 16 build files). Main artifact:

`f7fee85e76373886850412ab1d235951414949938c6713cb8026611fe56f3202`

Preload artifact:

`b7f29dbcf075eaf71edf6adb6ab015cf122d1bb8408bb040f6077b147629eadb`

Retained App scene: `scry-electron-smoke-OglwY6`. The registered stop helper returned; this does not prove escaped-descendant or remote-effect closure.

## Failures retained, not cleared

The expanded run has **298 passing and 2 failing tests / 26 files**. Both failures use the original 5000 ms deadline in `workflow-dynamic-revisions.test.ts`: stable-map consumer revision and nested-unused revision. The failed command did not reach its build step. The later focused build is reported separately.

One frozen-source control restored the three affected runtime modules byte-for-byte to `workflow-app-turn-archive.0s7vqv54`, retained the six test bodies and original deadline, and reproduced the stable-map timeout (5 pass / 1 fail). This establishes reproduction without these runtime edits, not a cause or a blanket unrelatedness conclusion. Current source was restored afterwards.

One separate functional phase capture again ran all six unchanged cases under the original deadline: 5 pass / 1 fail. At the stable-map deadline:

- The second revision, `consumer-change`, was still awaiting its response, with a store `save` outstanding.
- The observed 11 synthetic attempts were completed and settled. The last committed root still reported running revision 49 and an active execution owner.
- The latest bounded frame observations were completed. They do not cover every historical frame.
- Cleanup had not entered. This failure is therefore not an awaited-directory-removal timeout.
- The capture does not identify the lower-level cause of the outstanding save or prove that it was the final terminal commit. No elapsed-duration profiling, sleep, retry, deadline increase or workload reduction was added.

Capture: `revision-functional-2-failure.json`, `revision-functional-capture.log`. Diagnostic instrumentation existed only temporarily in the fixture; restoration is byte-checked in `revision-functional-restoration.json`. The test bodies and production source were not changed by the capture. A first attempted JSON read hit the tool's output bound; subsequent structured parsing reports selected fields, not a full human read of the large capture.

Source review also identified a separate fixture lifecycle limitation: `service.close()` freezes admission but does not await active execution before fixture directory removal. This capture did not reach cleanup, so that limitation is not its demonstrated cause. Parent owns a separate convergence-safe fixture review; it must not be advertised as this timeout's fix.

Earlier SystemStep, recovery, Node TAP and unified-App deadline failures remain open. Initial fixture-contract failures and the missing Runner correlation carry were corrected and retained in the logs; later passing checks do not erase them. Claude CLI validation remains user-excluded, not passed.

## Remaining work

Parent continues the main-owned, workspace-only chat TaskSubmission and opaque planner handoff. Workflow/template association, manual/auto policy with explicit fee/data authority, combined routing/planning, remaining command execution and the later milestones are still open. Further performance experiments require a new allowance; the current allowance remains zero. No staging, commit, push, install, version bump or daily-App restart occurred.
