# M5 recorded output inspection: bounded read-only slice

This completes the selected-output slice after [metadata inspection](execution-inspection-status.md), not full M5 or M1–M6 delivery. The implementation owner for the remaining work is the parent task.

## Behavior and authority

- `workflow.inspectOutput` accepts only a workflow/current governing revision and an issued attempt, SystemStep or frame identity. System selection is restricted to result/stdout/stderr. Main rejects paths, URIs, caller-supplied value/output references, unknown fields, invalid bounds and nonzero pages without a content identity.
- Main validates its workspace authority before artifact access and again after asynchronous reading. It validates the frozen governing source and reports `source_changed` rather than relabelling older results. The response separately preserves the recorded source revision, including unavailable intent provenance.
- Agent reads use the durable hash-checked output even when an in-memory outcome also carries text. System/frame reads reuse canonical `loadValue`/`loadFrame`, including collection authority checks; they do not expand collection members or scan directories, transcripts or SQLite. Corrupt artifacts reject, never become empty/success/unavailable fallback data.
- Metadata remains body-free. Bodies load only after an explicit click. Canonical duplicate logical IDs select the same last intent/outcome as metadata. Missing selection, missing output, unknown value, known empty content, capture truncation and page windows remain distinct.
- Pages contain at most 8192 UTF-16 code units and do not split valid surrogate pairs. SHA-256 over exact UTF-16LE display units pins later pages and preserves unpaired surrogates. This is content identity, not a file digest, signature or execution authority. Changed identity is checked before interpreting an old offset in a shorter replacement body.
- The existing 8 MiB artifact policy remains. JSON is compact, text is read-only, and both are rendered as text, not HTML or executable code. Frame and system result labels remain distinct. Nested modal focus/Escape/Tab reuse `ModalFrame`.
- Retry/back preserve the expected body identity. `content_changed` offers a first-page restart. Streaming parent renders do not reread an identical logical selector. No polling, cache, Agent dispatch, check execution or additional execution owner was added.

## Current verification

Repository `scry-workflow-m0`, branch `feat/workflow-m0`, HEAD `c9386b60c8487b0886a0d2c6594d51c050169d58` plus the retained dirty source. These are isolated local fixtures, not real Provider SDK/account evidence.

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web typecheck | Passed | `/tmp/scry-workflow-output-current-validation.log` (Node); `/tmp/scry-workflow-output-final-ui-build.log` (web) |
| Extra fixture typecheck | Passed against the existing web configuration plus Workflow UI fixture | `/tmp/scry-workflow-output-ui-types-corrected.log`; production tsconfigs otherwise omit these scripted UI fixtures |
| Focused regressions | 13 files / 88 tests passed at unchanged deadlines | `/tmp/scry-workflow-output-current-validation.log`; real cold FileStore paging, canonical joins, corruption, authority revocation, actual Node streams/result/frame values, trusted sender/frame/origin rejection and preload forwarding |
| Native-input UI, scripted bridge | Passed | `/tmp/scry-workflow-output-final-ui-build.log`; lazy metadata, Unicode paging, pinned error/back/retry, changed-body restart, empty/missing/unknown, old-source provenance, capture warning, parent rerender, three-level focus/Escape and Tab containment |
| Narrow UI | Passed for 430px and measured elements | `/tmp/scry-workflow-output-ui-narrow.png` inspected; no overflow, text contrast 15.069:1, padding 20px. Not all themes or a full accessibility audit |
| Current production build | Passed | Same UI/build log, 349 Main modules; no packaging or install |
| Production renderer/preload/Main | Passed with real Node check and offline Provider adapters | `/tmp/scry-workflow-output-reviewed-native-app.log`; isolated `scry-workflow-node-stop-app-Xe7FrT` verification/execution-inspection JSON |
| Independent artifact readback | Five selections matched canonical recorded bodies and UTF-16 identities | System result 862 units, stdout 24, stderr known empty, frame JSON 220 and offline Agent text 47. Explicit issued addresses only; no directory/frame discovery |
| Cold production readback | Exact bodies/provenance retained; no redispatch | Same production JSON: `coldBodiesPreserved`, unchanged warm ledger bytes, no additional Provider calls; the existing full fixture totals four offline actors |
| Registered process closure | Observed for all three fixture launches | `closure.json`: four registered resources each; identity-checked termination. This does not prove escaped descendants or remote effects closed |

Native probes used the existing timing lock. Latest host load was 9.82→9.65 on ten cores; functional acceptance is not a speed claim. Existing performance collector unavailability and earlier wider-suite failures are not turned into passing gates here.

## Retained failures and controls

- Initial typecheck lacked the shared invalid-request copy; corrected. The first new unit fixture accidentally recursed through its own spy and exhausted the heap; it was corrected without a heap/deadline increase. Subsequent failed assertions and union narrowing errors were retained before the passing focused run.
- Extra fixture typechecking found missing System outcome identities and the older empty bridge's missing captured-Task methods. The fixture now supplies real DTO fields; unsupported fixture Task operations explicitly reject instead of pretending availability. First log: `/tmp/scry-workflow-output-types-with-ui.log`.
- Shortened-content regression failed on the original offset-first implementation (`/tmp/scry-workflow-output-shortening-red.log`). Identity-first checking passed with the same assertion and also retained exact unpaired UTF-16 content. No test was weakened.
- Reintroducing selector-object effect dependencies failed the native UI assertion with 12 reads instead of 11 (`/tmp/scry-workflow-output-ui-identity-negative.log`). Original source was restored and byte-compared; the reviewed source subsequently passed the complete UI and production probes.

## Still open

- Complete bounded canonical frame enumeration/runtime graph, RecorderSQLite integration, retry/token/cost history and near-limit program interaction remain open. Do not guess frame IDs/parents or infer graph completeness from this inspector.
- Native artifact/UI samples fit one page. Long durable Unicode pagination is proved separately by real-store tests and scripted native-input UI, not by a near-8-MiB production App workload.
- Main remains 168,439 bytes and blocks the authored-file cap. All other currently changed/untracked authored files are below 20,000 bytes; this is not staging readiness.
- Original revision timeouts/`ENOTEMPTY`, the retained expanded history timeout and catalogue-layout gate failures remain recorded. Current focused passes do not erase them. No deadline, workload, metric, ratchet or performance experiment changed.
- No real Provider/SDK/account or Jev fee acceptance; Claude CLI remains explicitly excluded. No commit, push, install, version change, business workspace write or daily App restart.

Full remainder: [remaining map](remaining-map-status.md). Checksums in local evidence archives establish consistency only, not release approval or portable authority.
