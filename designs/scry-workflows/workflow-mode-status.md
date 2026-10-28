# Conversation workflow mode and routing status

M2 chat-entry increments: per-conversation mode, one routing call per new message in either recognition mode, and a request-only UI choice. Template-edit dispatch now opens the source-aware editor; model-authored edit candidates and its durable configuration Task remain incomplete.

## Implemented

### Conversation-scoped mode

- `Conversation.workflowMode?: 'off' | 'manual' | 'auto'` is conversation state, not a global preference. An absent field means `off`; older records are never rewritten with a fabricated default.
- `/scry-workflow mode off|manual|auto` is a typed command. Main persists it through the existing conversation metadata path (`updateMetadata` with a `workflow_mode` change), keeping the CAS revision check, the deletion fence and the single ownership admission. The renderer receives `mode_updated` and shows centralised notice copy.
- Both `manual` and `auto` write a grant that **Main** builds: `workflowRoutingConsent = { grantedAt, scope, acknowledgesExtraCall: true }`. The renderer only asks for the mode; it never supplies the disclosed scope or the cost acknowledgement. The scope text is stored verbatim so later copy edits cannot widen an older grant. Switching away from `auto` does not erase the grant, because it is evidence of what was disclosed.
- `manual` routes each new human message to recognize explicit natural-language workflow execution intent. Ordinary tasks stay on the direct path even when complex. This is model-based recognition, not a keyword regex. Legacy manual records without a routing grant are blocked until explicit opt-in; reading them never creates consent.
- `auto` asks the router to put substantive tasks on the workflow path even when a single call suffices. Greetings, casual chat and simple explanations may go direct. This prompt contract is tested, but recognition accuracy is not proven by the offline fixture.
- `ConversationSummary` exposes `workflowMode` and `workflowRoutingConsent` so the UI can show the current mode without reading the full record.
- `WorkflowModeChoice` in the conversation's 对话选项 renders the three modes, labels both recognition modes with their per-message routing cost, asks for the stored scope before first enabling either, and shows the stored grant afterwards. It writes through the same `conversations.update` channel as rename/pin/archive.

### One routing call in either recognition mode

- `WorkflowService.routeCommand` reuses the explicit-planning lifecycle: same durable planning intent, same slot, same receipt map keyed by `commandId`, same `scopeSettled`/`providerDispatch` evidence, same frozen-root admission for a program.
- The reply is a discriminated decision, not prose: `{"route":"direct"}`, `{"route":"clarification","question":"…"}` or `{"route":"workflow","body":…}`, or `{"route":"template_edit","target"?:…}`. Unknown keys, an empty question, a missing body, non-JSON, or an unknown route are rejected — the call fails rather than guessing.
- Only a `workflow` decision enters `admitPlanningOutput`, which publishes an `awaiting_approval` root. `direct`, `clarification` and `template_edit` publish no root: nothing can be approved, started or resumed from them.
- The decision is recorded on the planning intent (`route`, `routeQuestion`, `routeTarget`) and validated on read, so a tampered record is rejected.
- Replay is evidence-based: the same `commandId` returns the cached receipt, and a cold service re-reads the durable intent; a `workflow` decision re-reads and re-freezes its root. No second call is made.
- The requested `routingMode` is included in the receipt fingerprint and forwarded to the authoring prompt. Reusing a command id under another mode is rejected; warm and cold reads do not call the model again.
- Routing never approves execution. The draft opens the existing launch dialog with `workflowLaunchRequest(preview)`; the user must approve the exact `programRevision`.

### Per-send override

- `message.workflowOverride: 'direct' | 'workflow'` is consumed by that one request. It is never stored, so it cannot pollute the conversation mode.
- `direct` skips routing even in `auto` mode.
- `workflow` captures an explicit run task (`/scry-workflow run <prompt>`) through the existing capture path and returns `open_workflow_planner`. It still requires approval.
- Explicit commands (`list`, `size`, `mode`, `run`, `template`, `edit`, **`direct`**) take precedence over both routing and the override, so they never pay for routing twice. Explicit `direct` does not require routing consent even when the stored mode is `auto`.
- `WorkflowMessageChoice` exposes three native radio choices alongside command selection: conversation mode, direct, workflow. The small fixed set stays visible and supports native arrow-key navigation. It is disabled during an active run, unknown request, fork, or selected explicit command.
- `useConversationSubmission` preserves the choice across the effect-free `needs_native_context` response when it merges the authoritative native context. An unknown ACK retains the exact request and command id. A rejection or source negotiation retains the choice; an accepted direct turn or control consumes it. No metadata write changes the stored conversation mode.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Node and web typecheck | Pass | `npm run typecheck` |
| Submission contract | mode command, invalid mode, auto routing (direct/workflow/clarification), missing grant, override direct/workflow/invalid, explicit command precedence | `desktop-conversation-submission.test.ts` 25 tests; 3 cover explicit direct with auto and each pending override |
| Routing service | one call per decision, no root for `direct`/`clarification`, `awaiting_approval` root for `workflow`, warm and cold replay without a second call, malformed decisions rejected, empty message rejected, commandId reuse rejected | `workflow-route.test.ts` 8 tests |
| Store mode path | `manual` persists and survives a fresh store read, stale revision rejected, `auto` stores the main-built grant, `off` retained with the grant | `conversation-management.test.ts` 12 tests |
| Production build | Pass | `npm run build` |
| Workflow service regressions | Pass | `workflow-service.test.ts`, `workflow-service-shutdown.test.ts`, `workflow-service-stop.test.ts`, `workflow-service-planning.test.ts` |
| Historical auto-only App evidence (superseded below) | 6 offline provider calls: mode command (0 calls), `direct` route (1 routing + 1 ordinary turn), `workflow` route (1 routing, root `awaiting_approval`, `dispatchAttempts: 0`), `clarification` (1 routing, question surfaced, no dispatch), override `direct` (no routing), override `workflow` (task captured, no plan call), `manual` plain message (no routing) | `node scripts/workflow-mode-app-smoke.mjs` → `scry-workflow-mode-app-rdegIn/routing.json` |
| Cold restart | stored mode `manual` survives; 6 calls unchanged, so nothing replayed | same evidence, `coldWorkflowMode: "manual"` |
| Real App widget | the mode control renders in the real conversation options with all three options and their cost/limit labels; its React handler writes through the preload channel (synthetic `change` event, not a native select gesture); no Provider call | same run, `scry-workflow-mode-app-BgTBdB` |
| Conversation ownership App IPC | still passes after the new submission dependency and the summary projection | `node scripts/electron-security-smoke.mjs --dev-conversation-ownership-only` |

### Earlier per-message UI evidence (before manual recognition)

- Focused regression: **5 files / 61 tests passed** (`desktop-conversation-submission`, `workflow-route`, `conversation-management`, `conversation-handoff`, `task-submission`). Typecheck and production build passed.
- Scripted bridge with actual React/Chromium input: `scry-conversation-readback-h55rAa/result.json` records native radio keyboard navigation, direct override surviving native-context negotiation, rejection retaining choice, configuration-only workflow capture, disabled choice while ACK is unknown, exact request readback, one-message consumption, and unchanged adjacent command/template/task tests. The 430px viewport has no horizontal overflow.
- Production Main and offline adapter: `scry-workflow-mode-app-9xczI2/routing.json` retains the original six-call workload, adds one ordinary composer call in auto with **no routing**, then captures one new workflow task via the composer with **no planner/worker call**. Both choices leave the stored mode `auto`. Explicit restoration to `manual` survives another cold restart with the call count still **7**.
- Negative control: removing the native-context message merge makes the UI regression fail with `undefined` instead of `direct` (`/tmp/scry-workflow-message-choice-negative.log`). The correct source was restored.
- New explicit-direct regression failed **2/3** before its Main fix: auto incorrectly required consent, and a pending workflow choice captured instead of answering (`/tmp/scry-explicit-direct-first.log`). All three pass after the fix.
- First two UI attempts exposed hidden-window native-select navigation limitations (`scry-conversation-readback-V6Etyg`, `…-h444Rk`). The final small fixed-choice control is a visible native radio group; its real pointer and arrow-key checks pass. No popup acceptance is claimed.
- First App extension sent the second gesture before the renderer observed the preceding settled turn (`scry-workflow-mode-app-ZgVKEE`). The probe now waits for the existing disabled state to clear and asserts the selected choice before sending. It uses a new isolated workspace, not a replay of an unknown request. No deadlines were changed.
- `performance:measure --scenario send.codex-fixture` remains **unavailable**: `No counter collector matches send.codex-fixture`. No speed claim, baseline change, or new collector.

Historical unresolved failures include the original six 5000ms timeouts and `ENOTEMPTY` cleanup error. The later revision-fixture regression still had **9 passed / 12 timed out** at 5000ms (`pi-bash-d121caffd73b14c6.log`). One isolated native revision test passed at 4785ms under the unchanged deadline; that is not a repaired/full regression. Their independence from these changes is not established. The diagnostic 60-second rerun is not acceptance evidence.

## Manual-recognition checkpoint (before template-edit/analytics increments)

- Before the fix, the new contract checks failed **5 / 33** (`/tmp/scry-manual-mode-first.log`): manual did not route, mode identity was not forwarded, and both prompt contracts were wrong. The old assertions that manual was free/never routed were inconsistent with `chat-entry-semantics.md` §2, so their expectations now follow that contract; no deadline or assertion was relaxed.
- Final focused run: **11 files / 101 tests passed**, including submission, routing, stored consent, durable planning receipts, session catalogue, discovery, fork boundaries and performance classification. Typecheck and production build passed.
- Current isolated production App: `scry-workflow-mode-app-soDLId/routing.json`. Manual direct spends one router plus one ordinary turn; explicit workflow spends one router and leaves an `awaiting_approval` root with **0 dispatches**. The original auto/clarification/override scenarios remain. Total **8** calls before the trusted composer scenario, **9** after its one ordinary direct call; both cold restarts replay nothing.
- Current React/Chromium command fixture: `scry-conversation-readback-g1vqsT/result.json`. Native radio keyboard navigation, native-context merge, unknown identity, one-shot consumption and narrow layout pass.
- Production ownership IPC after the discovery/fork extraction still blocks six owned/orphan operations and permits three unowned controls. Exactly two offline operations execute; committed archive/workspace output and startup-failure recovery survive restart.
- First manual App probe failed because its old broad summary selector opened the task menu, not conversation settings (`scry-workflow-mode-app-RlQEMY/ui-failure.json`). The probe now targets the details containing the actual mode control and requires visibility. A fresh isolated run passed; no timeout, retry loop or business write was added.
- These are offline-adapter tests, not real semantic recognition/account acceptance. The timing wrapper reported high host load; no speed claim is made.

## Not verified / still open

- The select change remains synthetic, not proof of native popup selection. The current App probe does use trusted pointer clicks for manual consent cancel/confirm, verifies selection alone creates no grant, and verifies cancellation leaves consent absent. The auto-labelled confirmation button was not separately clicked.
- `auto` routing does not pin a model: it uses the selected provider and agent profile. The composer's model label is not a validated workflow model identity, so it is deliberately not forwarded.
- A `clarification` decision is shown as the rejection message. There is no dedicated question surface yet.
- `template_edit` routing and explicit `edit` now open the source-aware editor without execution or a second model call. Current checks: 20 files / 193 passed; production App `scry-workflow-mode-app-zyCUoP` includes exact source/instruction, 430px desktop layout and cold no-replay. See `template-edit-entry-status.md` for negative evidence and the remaining model-authored candidate/Task gaps.
- Remaining M2: `research` is unavailable; model-authored edit candidates and fully Task-ified standalone/workbench entries are incomplete.
- M3 general stall/restart, the remaining M4 quality programs and Jev, M5 full graph/output/RecorderSQLite, and the M6 real Provider/account matrix remain open. Claude CLI stays user-excluded; offline adapters do not prove real account or SDK acceptance.
- `src/main/index.ts` remains over the authored size limit; nothing was committed, pushed, installed, or version-bumped, and the daily App was not restarted.
