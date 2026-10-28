# M5 execution inspection: bounded read-only slice

This is a partial M5 checkpoint, not completion of M1–M6. It adds inspectable program structure and canonical execution metadata without another execution chain. Later bounded output-body delivery and its separate evidence are recorded in [output inspection](output-inspection-status.md); the verification below belongs to this earlier metadata checkpoint.

## Product behavior and authority

- `WorkflowProgressPanel` opens **程序与记录**. Structure and selected-block read-only code use the same frozen `preview.program.body` object. Structural edges describe the program, not inferred runtime dependencies or successful execution.
- Structure renders 32 nodes per page. The code view is the selected block's JSON; it is not another executable representation. Deep visual indentation is capped; the underlying structure retains exact parent IDs.
- `workflow.inspectExecution` reads Agent attempts or platform steps from the canonical root ledger, 32 records per page. It unions intent/outcome identities rather than counting lifecycle events twice. History is not restricted to the old last-32 progress view.
- Each record preserves its own program revision, retry identity, recorded model/provider, state and physical-settlement evidence. Missing intent/outcome/model is unavailable, not queued/completed/zero. A returned platform step is not a passed check.
- Exact-node filtering is not a subtree query. Legacy platform outcomes without an intent have no invented node or step kind. Admission frame references take precedence over older call-frame references; explicit clicks reuse the existing canonical frame inspector.
- The new trusted IPC rejects unknown fields, malformed identities/revisions/kinds and invalid offsets before the privileged read. Main loads the governing record, awaits its own workspace authority, validates the frozen source and refuses a changed source. Renderer cannot supply cwd, a path, authority or execution actions.
- Projection sends no output/check/stdout/stderr/input/replica bodies. Errors are capped at 4096 characters and labelled when truncated. It constructs only the selected page's DTOs; no cache, polling, frame-directory scan or model request was added.
- A warm query reads one governing root. Existing cold service initialization can reconcile records; this endpoint does not add a separate recovery/execution path. Pages are separate observations, not a cross-page atomic snapshot.

## Implementation

| Boundary | Files |
| --- | --- |
| DTO and source-aware projection | `src/shared/workflow-inspection.ts`, `src/main/workflow-execution-inspection.ts`, `workflow-service-foundation.ts` |
| Trusted IPC/preload and frame-reference reuse | `workflow-ipc.ts`, `src/preload/workflow-api.ts`, `workflow-progress.ts` |
| Same-source structure/code and paged metadata | `WorkflowExecutionInspector.tsx`, `WorkflowExecutionHistory.tsx`, `workflow-program-structure.ts`, `workflow-inspection.css` |
| Copy | `src/renderer/constants/workflow-inspection-copy.ts`, `src/shared/constants/workflow-inspection-copy.ts` |

## Verification at the metadata checkpoint

| Check | Result | Evidence / scope |
| --- | --- | --- |
| Typecheck and build | Passed | `npm run typecheck`; `npm run build`, 344 Main modules, Main 2739.85 kB, preload 28.40 kB |
| Focused regression | 47 files / 487 passed, original deadlines | `/tmp/scry-execution-inspection-regression-completed.log`; includes the prior entry/recording/IPC suites plus new projection, trusted IPC, preload, structure and frame tests |
| Real Service/Runner/Interpreter | 35 offline calls arranged, then 32 + 3 metadata rows without more effects | `workflow-execution-inspection.test.ts`; also intent-only/outcome-only, old-source/model/retry, unknown versus settled, workspace refusal, single warm root read and a fresh FileStore/Service cold read |
| Production trusted wrapper | Foreign sender/frame/origin rejected before privileged listener | `workflow-execution-ipc.test.ts`; malformed query fields also reject before the reader |
| Payload negative control | Fails if raw System outcome is spread into the DTO | `/tmp/scry-execution-inspection-payload-negative.log`; leaked check/canary assertions fail; original implementation restored and compared before final passing checks |
| Same-source structure | Exact object identity, structural parents/order; no fabricated loop instances or state | `workflow-program-structure.test.ts` |
| Native-input UI, scripted bridge | Passed | `/tmp/scry-execution-inspection-ui-current.log`: 37 structural nodes, 35 records, paging/filter/source-change refusal, nested Escape/focus, Tab containment, 430px no overflow, original mutation counters unchanged |
| Narrow UI readability | Passed for measured elements | Heading/hash/textarea text contrast 15.069:1, padding 20px; `/tmp/scry-workflow-execution-ui-narrow.png` inspected. This is not a complete accessibility audit or all-theme proof |
| Production renderer/preload/Main | Passed, no additional Provider calls or ledger writes during inspection | `scry-workflow-node-stop-app-Hoip2B/execution-inspection.json`: real native-only replica/check ledger, exact source/code, reference-linked frame, changed-source refusal, extra-authority rejection, warm ledger bytes unchanged |
| Production cold history | Exact records retained, no redispatch | Same JSON has `coldHistoryPreserved: true`; existing 2-then-4 offline actor counts remain. Three fixture launches, four registered resources per launch, `closure.json` |
| Existing performance collector | Unavailable, not zero/pass | `/tmp/scry-execution-inspection-performance.log`: no counter collector matches `send.codex-fixture`. No benchmark/workload/ratchet change or speed claim |

The production App probe uses actual Main persistence and a real Node check process, with offline Provider fixtures. It is not real Provider/SDK/account acceptance. Resource closure covers registered fixture resources, not escaped descendants or remote effects. Timing wrappers reported high host load; elapsed times are not performance conclusions.

## First failures and corrections

- The initial projection test failed because the older call-frame reference won over the canonical admission frame (`/tmp/scry-execution-inspection-first.log`). The shared production selector was corrected; assertions were not weakened.
- Initial UI inspection used a nonexistent frame selector; it was corrected to the real metadata field. A later existing lost-ACK scenario exposed a stale remount wait: old text was already present before the replacement fixture mounted. The fixture now exposes its generation and waits for the new DOM before the next gesture.
- Pointer checks now reuse the existing hit-tested native-input helper. `sendInputEvent` dispatch is asynchronous, so the probe waits for the trusted target receipt before asserting it. No click replay, sleep, retry loop, deadline increase or skipped assertion was added. Logs: `/tmp/scry-execution-inspection-ui-first.log`, `...-ui-final.log`, `...-ui-checked.log`, `...-ui-observed.log`.
- The first broad regression command was interrupted before a RUN/results section. `/tmp/scry-execution-inspection-regression.log` is unknown, not passed. After checking no target test process remained, the same 47-file scope ran to completion in the separate completed log.

## Still open / limits

- This is program structure plus canonical attempt/SystemStep metadata and explicit frame links. It is **not** enumeration of every dynamic/pure control frame, a complete runtime graph, RecorderSQLite integration or token/cost retry history.
- Full frame enumeration needs a bounded canonical index or equivalent contract. Do not infer scope/parentage from ID strings or scan every frame file on interaction. The implementation owner remains the parent task.
- Selected-block code uses the existing full frozen preview. The root record has the existing 8 MiB limit and compiler limits; near-limit program interactivity has not been verified. Before full M5 delivery, add interaction evidence at the supported contract limits. If code delivery cannot meet the existing limits, add bounded code delivery rather than claiming current small fixtures prove it.
- Original revision regression timeouts (9 passed / 12 timed out at 5000ms) and historical `ENOTEMPTY` remain unresolved; their independence from this work is not established. No timeout was raised.
- Main remains 171,447 bytes despite zero inline trusted handlers, so the changeset is not staging-ready. No commit, push, install, version bump or daily App restart occurred. M2–M6 remainder is tracked in `remaining-map-status.md`.
