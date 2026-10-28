# Typed desktop command UI checkpoint

This is a partial M2 checkpoint, not M1–M6 completion. No release, install, commit or push is included. Claude CLI execution remains excluded at the user's request; its earlier failed probes are not passes.

## Implemented

- `ConversationView` sends through the typed Main-owned `conversation:submit` dispatcher. Renderer-side Workflow command parsing and name-based conflict decisions are removed.
- The command picker reads known Scry metadata without starting native discovery. Reading the current Agent's catalogue requires a separate explicit action. Public source IDs are selectors, not execution, authoring or fee grants. Main resolves them again.
- Known rejection and source-selection responses keep the draft without an unknown-write lock. A failed submit keeps the complete original request and command ID. It does not automatically retry or change branch.
- `list` opens the existing template manager. `size` uses the existing preference authority, including default reset and file-override refusal. Controls reject attachments/references even when no native target is supplied.
- `run` requests the existing planning configuration UI and keeps the draft. It does **not** generate a plan, approve a revision or start a Workflow. `direct` keeps the full original command in immutable task input and sends only its parsed goal through the existing actor.
- `WorkflowLaunchDialog` is extracted and reused for global and conversation-local frozen previews. Its entire planning/approval body is unchanged. A prepared template is not replanned or automatically approved.
- Catalogue results are fenced across UI scope changes. The picker renders at most 40 matching rows, with filtering and an explicit count. Source selection returns focus to the composer; Escape closes the picker and returns focus to its summary.

## Current checks

Logs are under `/tmp/scry-workflow-task-entry.V7ObQf/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web types, related units | 18 files, 188 tests passed | `conversation-command-current-gates.log` |
| Existing readback fixture | Six original requests; stale responses, pagination, callbacks and unmount fences passed | Same log; scene `scry-conversation-readback-i0uxYG` |
| Real ConversationView UI fixture | Source choice, settings, actual manager opening, draft retention, exact retry identity, stale metadata, trusted pointer input, Escape focus and 430px desktop layout passed | Same log; scene `scry-conversation-readback-efOPex` |
| Existing Workflow UI fixture | Original planning/approval/stop/recovery workload passed | Same log; this is a scripted bridge, not a real Provider |
| Build | Passed | Same log |
| Launcher extraction | Complete approval body, complete panel body with explicit import/rename changes, request contract and shared preview conversion match; approval-guard mutation rejected | `workflow-launch-equivalence.json` |
| Design detector | No static findings in the four inspected UI/CSS targets | `conversation-command-design-detect.json`; not a complete accessibility audit |
| Current production preload/Main IPC | Existing ownership and default-off task workload passed, including new control responses and no extra actor for controls | `conversation-command-current-app.log`; scene `scry-electron-smoke-D8ap7p` |

`conversation-command-current-app-identities.json` binds current sources and all 16 build files. The production IPC fixture uses the existing FakeProvider: four total adapter calls (legacy fork/run and two task runs), one call for concurrent duplicates, and zero calls for the late-fenced task. Its canonical delivery is `not_sent`; observation does not reopen the unknown fence. Cold observation leaves recorded input bytes unchanged. The existing stop helper returned; this does not prove closure of escaped descendants or remote effects.

The UI fixture uses the real component and Chromium input with a scripted bridge. The separate App fixture uses real preload/Main IPC with FakeProvider. These are distinct checks, not one real-Provider UI-to-model acceptance test. The planning callback count in the UI fixture proves configuration navigation only, not model invocation.

## First failures retained

- `command-ui-prerequisite.log`: TypeScript could not narrow the grouped command union after the control branches. An explicit `size` branch fixed the source; the corrected prerequisite gate passed.
- `conversation-command-ui-first.log`: the hidden fixture's injected OS Select All shortcut did not select the composer text. The independent boundary diagnostic retained `selection: [15,15]` with composer focus. The fixture now uses Electron's native editing command and checks focus plus the full selection before inserting text. This does not prove the OS keyboard shortcut.
- `conversation-command-native-edit.log`: Escape did not close the picker when focus was outside it. Adding initial filter focus exposed a separate delayed native-toggle race in `conversation-command-focus-fixed.log`: the filter stole focus after source selection. The picker now has one controlled open-state owner instead of feeding delayed native toggles back into state. The checks retain stronger closed-menu/composer-focus assertions; deadlines were not raised.

All failed UI scenes and their available diagnostics remain retained. Machine-load metadata is not a causal explanation or a performance result. Performance catalogue mappings changed only to track moved/new sources; workload, metrics, ratchet and deadlines did not change. The unavailable `send.codex-fixture` collector is not reported as zero or passed.

## Still open

The Main-owned policy is still the default-off direct slice. Manual/auto policy persistence and explicit data/fee grants, one combined route/plan call, generic Workflow/template-edit task provenance and exclusive dispatch, restricted authoring consumption, native command execution, research/template/edit commands and the remaining M3–M6 work are not complete. Unsupported actions are refused without ordinary-message fallback.

Opening planning configuration is not immutable Workflow TaskSubmission admission. The old planning path still needs that integration and canonical restricted-authoring consumption. The parent implementation lane owns these next changes. Existing SystemStep/recovery/TAP/full-suite failures remain open and are not cleared or declared unrelated by these focused passes. `src/main/index.ts` remains over the authored-file size limit and must be split before staging/delivery.
