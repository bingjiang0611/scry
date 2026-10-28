# Captured chat workflow tasks — partial M2 checkpoint

This checkpoint connects `/scry-workflow run` in a conversation to the existing planner. It is not complete M2 or M1–M6 delivery.

## Implemented boundary

- Main captures the exact original command, Main-resolved Scry operation, canonical workspace/device/inode identity and size evidence before returning a configuration dialog. Version 2 has no invented native Provider, continuation key, model or account. Existing version-1 direct-task bodies remain unchanged.
- The Main-issued conversation/command reference is a lookup, not authorization. Plan and cancellation carry it unchanged. Reserved `submission-<sha256>` planning IDs cannot be sent without that reference to bypass the captured path.
- The original goal and recorded size are read-only in the captured dialog. Roles can be configured before the first planning request. Later observation uses the same planning identity and frozen configuration; it does not silently create another root.
- Main validates the raw input digest, canonical workspace authority and identity. It persists the exclusive workflow intent/configuration hash before calling the existing `WorkflowService`. A private callback rechecks the latest fence after preparation and before the existing Provider dispatch markers.
- The planner consumes the captured valid size snapshot, not current preferences. Unavailable evidence blocks planning without inventing a default. Ordinary direct chat still permits unavailable workflow-size evidence.
- Association is validated against the canonical root and its atomic planning-request hash. It is a historical root/revision reference, not execution approval, Provider settlement or physical process closure. Generated workers still require approval of a concrete program revision.
- Cold/unknown intents can only observe matching canonical evidence. Missing journals, unknown physical scope and changed configuration never trigger another model request. Attaching observed root evidence does not reopen an unknown fence.
- Cancellation fences the task before signaling the existing registered planning identity. Like the existing trusted `cancelPlanning` path, cancellation does not require the archived conversation or removed workspace to become writable again. New admission and dispatch still require current workspace authority. Cancellation acknowledgement is not physical-settlement proof.

No second planner, SDK loop, scheduler, global singleton or execution budget was introduced.

## Verification

Evidence root: `/tmp/scry-workflow-task-entry.V7ObQf`.

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web types, focused units, build, whitespace | Passed; 12 files, 180 tests | `workflow-task-current-gates.log` |
| Captured dialog and source-picker interaction | Passed with actual isolated Electron input and scripted bridge | `workflow-task-ui-corrected.log`, fixture `scry-conversation-readback-WyU6V4` |
| Existing readback and classic workflow dialog | Passed in the focused gate | `workflow-task-current-gates.log` |
| Negative controls | Three expected failures: reread current Small instead of captured Medium; refuse cancellation after archive/removal. Fixed source restored byte-identically | `workflow-task-size-cancel-negative.log` |
| Production preload/Main IPC and existing synthetic Provider | Passed; five total Provider calls, including one planning call for concurrent duplicate requests; zero generated workers dispatched | `workflow-task-current-app.log`, fixture `scry-electron-smoke-LTCAal` |
| Existing counter regression | Eight collector tests pass; parent publications `[3,3,3,3,3]` | `workflow-task-counter.log`, `workflow-task-counter/measure.json` |

The new FileStore tests cover immutable workspace-only capture, first configuration, duplicate and changed input, lost claim/association acknowledgements, cold observation, unavailable size, workspace replacement, unknown physical scope and cancellation fences. They use synthetic executors, not a native SDK.

The App case captures without native context or a model call, then changes the global preference to Small. Its canonical plan retains the exact captured Medium snapshot. The existing malformed-workspace-recorder challenge, canonical structured fixture result (not assistant-text fallback), original ownership refusals, direct-task fences and cold byte checks remain enabled. After retaining the completed receipt bytes, the fixture injects a failed planning receipt and unknown task state. Concurrent observation adds zero Provider calls and leaves both fences unchanged. This is controlled metadata fault injection, not a real App disk failure.

The first dialog check failed because the test expected the English word `medium` in a correctly localized label. The repaired test compares the centralized localized value/source and verifies that no global size editor exists. The failure and scene `scry-conversation-readback-wSOZtk` are retained. Initial type errors are retained in `workflow-task-planning-first.log`; no deadlines or assertions were weakened to hide them.

## Artifact and evidence scope

- Main SHA-256: `fdcd420028c25219154678349338ddca0dadd561fa1c57333611ace68044c68f`.
- Preload SHA-256: `cb1a30b8908c6bbb4544dc06e64a3812c41f64d42b4309f3aaffc222539bb58a`.
- `workflow-task-current-app-identities.json` was recorded before the App run and binds 69 source files and all 16 build files. `workflow-app-runtime.ts` and the changed renderer copy module were omitted from the individual pre-run source list; the compiled build is bound, and their source hashes are recorded honestly in the post-run supplement. No pre-run source evidence was reconstructed.
- The UI fixture and production IPC case are separate checks, not a single real-Provider UI end-to-end test. A late workflow fence is covered by the synthetic service test; the App case covers cold/unknown observation, not a separately coordinated late workflow-dispatch race.
- The counter row is unregistered: global ratchet success is not an enforced numeric gate. There is no baseline, comparison or profiler. It covers parent publication only, not total intake IO or a speed improvement. Known unavailable collectors are not reported as zero or passed.
- Cleanup evidence is limited to the existing registered-resource helper returning. It does not prove closure of escaped descendants or remote effects.

## Open work

Standalone/template workflow entries remain on their existing non-captured path. Full per-conversation off/manual/auto policy, live account/data/fee binding, combined routing/planning, remaining typed commands, task cards/reopening and explicit new-task versus revision UX remain open. Requested role/configuration hashes are not account or credential enforcement proof.

Real Claude CLI validation remains user-excluded, not passed. No real Provider account/model, Jev or spending was used. Earlier SystemStep/recovery/TAP/unified deadline failures remain open. The existing dynamic-revision capture locates an unfinished second revision/store save, not its cause; no performance experiment or deadline increase was performed here.

`src/main/index.ts` is still 225,285 bytes and blocks size-compliant staging. There is no staging, commit, push, install, version change or daily-App restart. The parent continues remaining M1–M6 work; this checkpoint is not final delivery.
