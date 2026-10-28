# Captured fixed-template task checkpoint

This checkpoint lets `/scry-workflow template …` enter the same Main-owned Task intake as captured `run` commands, then prepare and approve the exact frozen revision. It is not complete M2 or M1–M6 delivery. The native Claude CLI remains excluded by the user, not verified.

## Implemented boundary

- `extractTemplate()` and `instantiateTemplate()` moved unchanged from `workflow-service-planning.ts` into `workflow-service-templates.ts`. Inheritance is now `WorkflowServicePlanning extends WorkflowServiceTemplates extends WorkflowServiceFoundation`, with one shared `planningId` export and the same Store, admission owner, capability probe and Interpreter. The extraction was proven token/AST equivalent before any behaviour change.
- `instantiateTemplate(input, captured)` is Main-only. `captured.frozenSource` rejects drafts and reads the retained App-owned revision through `templates.frozen(ref)`, so a captured revision still prepares after its mutable catalogue entry is deleted. `observeOnly` returns canonical prior state instead of trusting cached receipts, and rejects with `taskSubmissionCopy.unknown` when no canonical root exists. The public legacy `workflow:instantiateTemplate` payload does not accept this second argument.
- Private `beforePrepare` is called at three boundaries: after the frozen-source read and lowering, before the capability group, and after system preparation and program compilation but before `store.create`. Each call re-checks admission generation; the captured-task controller re-checks workspace inode, conversation, owner epoch, dispatch branch and configuration hash at the same points. This does not add a second authority or execution chain.
- `observeCapturedTemplate()` reuses the existing canonical-root predicate: exact command, request hash, saved origin, template ref, trimmed raw command and workspace inside the bounded governing revisions plus the current preview, with `assertFrozen` on the original and revised bodies. It never prepares, plans, dispatches or writes.
- Task intake version 2 now discriminates `workflow_run` from `workflow_template` with a validated `WorkflowTemplateRef`. Both remain workspace-only `desktop_conversation_submit` with policy `off`/0, no fabricated Provider/model/target, and no `authoringContinuationKey` for templates. The strict decoder accepts only operation-specific keys and requires a project-scope template to match the captured workspace; version 1 rows are unchanged.
- `resolveWorkflowTemplateCommand()` parses and validates the sealed JSON parameter object before any catalogue query. An explicit scope reads one source; a bare template ID reads exactly builtin, personal and project. Zero matches means missing, more than one matching source is an explicit ambiguity, and an invalid matching observation occupies its source instead of falling through. IO errors propagate; only JSON and domain validation failures are converted to known rejections.
- The renderer sends only `reference`, `orchestrator` and at most three role bindings to the trusted `workflow:prepareTemplateTask` handler. Paths, source bytes, template bodies, purpose, frozen-source flags, callbacks and history authority are rejected before the privileged listener runs.
- The preparation dialog mounts no provider control until the user binds a role, so opening it cannot discover or default to an arbitrary provider/profile. It shows the immutable raw command, exact scope/template/revision identity and declared roles, interprets parameters only from the Main-sealed body, and states that preparation sends no model request. Escape during a pending preparation durably fences it through the existing `cancelPlanning` path with the task reference; the acknowledgement is not physical settlement, and a late continuation cannot open approval afterwards.
- Approval reuse is deliberately narrow. The concrete preview opens the existing launch dialog with the original template command and a `fixedTemplate` marker, so the current root cannot be reconfigured into a model planner even when its revised body no longer carries `program.template`. The planning-fee note is not shown for fixed templates, and approval still binds the exact `programRevision`.

## Verification

Logs are under `/tmp/scry-workflow-task-entry.V7ObQf/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Node and web types after the public wire | Pass | `template-task-public-types-fixed.log` |
| Focused public-wire contracts | 9 files, 100 tests pass | `template-task-public-focused.log` |
| Wider adjacent contracts | 21 files, 256 tests, 254 pass, 2 first failures retained | `template-task-focused-wide.log` |
| Captured template service | Ten cases: frozen source after deletion, canonical observation, missing instance, draft rejection, exact hash/source/goal/workspace negatives, real governing revision, three private fences, async admission close | `workflow-template-captured.test.ts` |
| Command resolution | Eight cases on the real template store: scopes, invalid collision, JSON/schema errors, source deletion, cold unknown with zero source calls, explicit correction | `workflow-template-command.test.ts` |
| Controller | Six cases on the real FileStore, ConversationStore and Service: exact freeze with zero planner/worker/authoring calls, deletion and cold duplicates, lost root ACK, lost claim ACK, cancel while the frozen-source read is pending, unavailable history | `desktop-template-task-entry.test.ts` |
| Trusted IPC | Production wrapper rejects sender, child frame, changed origin, forged source/path/purpose fields and over-limit roles before the listener | `workflow-template-task-ipc.test.ts` |
| Real React/Electron input | Unbound roles, raw-command escaping, retained draft, explicit role binding, narrow layout, no model planner, exact revision approval, cancelled late preparation fenced, unavailable history blocked, composer focus restored | `template-task-command-ui-visible.log`, `template-task-narrow.png` |
| Actual preload/Main/FileStore | Five original synthetic Provider calls total; template intake, preparation, duplicate preparation, observation and data-only execution add zero calls | `template-task-app.log`, scene `scry-electron-smoke-9T0UBI` |
| Cold restart observation | Completed instance re-observed after restart with preparation replay zero and canonical/input bytes unchanged | same log, `templateTaskCold` |
| Existing counter workload | Eight tests pass; five parent-publication samples are all 3 | `template-task-counter/measure.json` |

The actual App workload executes a data-only template whose sealed parameter value differs from its declared default, so `finalReport` proves the Interpreter ran the captured parameter rather than a default or canned answer. Provider entries stayed at the previous five.

The counter row is still **unregistered**. Global ratchet success is not an enforced numeric threshold, total-I/O or speed proof. No profiler, cache, prewarm, workload reduction or ratchet edit was used.

Pre-run `template-task-app-identities.json` binds 19 individually listed sources and all 13 built files; all 32 hashes were unchanged after the run. The UI scripted-bridge scenario and the actual Main/FakeProvider scenario are separate. Registered cleanup helper return is not escaped-descendant or remote-effect closure proof.

## First failures retained

- The first public-wire typecheck failed on three fixtures missing the new required `templateTasks` dependency and forwarding method. Tests were corrected, not the contract.
- The first UI run used Down/Return on an unopened native select in a hidden window and failed to change value. It now uses the existing closed-select typeahead path with native key input.
- The next UI run failed a reference assertion because one helper overrode `reference.commandId`; the helper returns the exact submission it opens, and the assertion uses it.
- Escape during pending preparation first failed to close the dialog: disabling the clicked prepare control dropped focus to `body`, so the modal no longer owned the key. The dialog now moves focus to its cancel control before preparing. A narrow-width screenshot then showed the immutable raw command at zero height; the container keeps `flex-shrink: 0` and the stricter height assertion fails without it.
- The wider run timed out two unmodified template-store suites at their original 5000 ms deadline under load 33–36 on ten cores. Isolated re-run passed (8.3 s and 28.1 s of fixture time). Both files import only `workflow-template-store` and `workflow-template-builtins`; neither imports this checkpoint's new modules. The first failures remain recorded and are not reclassified as load or unrelated causes.
- Earlier historical failures remain open and unmeasured here: full-suite, dynamic-revision, expanded-recovery, Node-TAP App and unified-conversation deadlines, plus the excluded native authoring acceptance.

## Remaining work

This covers one fixed-template chat command, not all standalone/template/native entries. Explicit new-task creation versus same-root replanning, complete reopen and configuration provenance, authoring availability UI, full per-conversation off/manual/auto policy, real data/fee/account consent, one combined route-and-plan step, other nested/research/edit commands, remaining M3–M6 acceptance and release gates remain open. `src/main/index.ts` is still over the authored-file size limit. No commit, push, installation, version bump or daily-App restart was performed.
