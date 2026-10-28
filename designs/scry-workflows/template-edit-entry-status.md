# Template-edit entry: implemented slice and remaining work

## Implemented

- Explicit `/scry-workflow edit [scope:]<UUID> <instruction>` resolves the source in Main without a routing/model call. No attachments or historical handoff are silently consumed.
- Both recognition modes accept a strict `template_edit` decision, with an optional bounded scope/UUID. A model cannot supply workspace paths, revisions, authorization or executable bodies.
- Main resolves that public selector using the conversation's authorized workspace and the existing template store. Bare IDs must match exactly one fixed scope; ambiguity/missing IDs are reported rather than guessed. Invalid definitions remain inspectable for repair. Execution still rejects them.
- The workbench opens the exact observed source/revision, keeps builtin definitions read-only, and retains the original instruction rather than a model paraphrase. Missing targets open the existing catalogue for explicit selection.
- Every explicit or routed edit is now a captured-only TaskSubmission v3. It freezes the original goal, exact instruction, normalized public selector, optional exact resolved revision and workspace identity. It has no workflow size, Provider/model/profile, planning hash, workflow root or dispatch state.
- Captured edit Tasks appear in the existing bounded list/inspect UI and reopen the same workbench after close or cold restart. Reopen reads the exact retained revision through `revision(ref)`; missing history is `source_unavailable`, never a current-source substitution. A prior App owner epoch does not interrupt a Task that never dispatched.
- No automatic draft write, publication, instantiation, planner call or worker execution follows an edit intent. Existing draft/review/publish and separate execution controls remain explicit.
- Routing records `routeTarget` on its durable planning intent. Cold readback validates the target and replays the decision without another call or a workflow root.
- Stale/archived requests are rejected before routing or edit reads, not after spending a call.
- For a v3 Task with an exact saved source, the workbench now offers one explicit, confirmed model-candidate action. It discloses the exact instruction/template/rules sent, the history/attachments/workspace files/credentials excluded, unavailable cost estimate, and the no-save/no-run boundary.
- Candidate generation keeps v3 captured-only. A separate bounded store freezes task/input/source revision, Provider/profile/requested model, capability identity and continuation identity before dispatch; terminal states are `candidate` or `unknown`, and duplicate attempt delivery only observes the durable record.
- Only canonical structured output with a committed archive is accepted. The candidate source is content-addressed and validated against the frozen template ID. Invalid source remains inspectable; assistant shadow text is never parsed. Cold reopen shows source, summary, requested/actual model, archive and full source comparison.
- Candidate generation cannot call planning, create a workflow root, create a draft, save, publish, instantiate, approve or execute.
- A reviewed candidate now has a separate explicit “create candidate draft” command. The user chooses personal/current-project scope and confirms the boundary. Main derives source/workspace and records a separate intent/applied/unknown receipt. A lost acknowledgement remains unknown and is never replayed; a known applied receipt cold-opens the exact draft.
- Applying a candidate creates an editable draft only. Cross-scope/builtin copies receive a new template identity; same-scope saved sources retain their exact base. It does not change the source definition, publish, instantiate, approve or execute, and it adds no Provider call.

## Evidence at this source

| Check | Result |
| --- | --- |
| Typecheck, production build, diff whitespace | pass; 356 Main modules, current Main bundle 2802.65 kB |
| Focused regression | Candidate generation remains 15 files / 164 tests pass. Candidate application adds 5 focused store/controller cases; combined focused scope is 16 files / 174 tests and covers explicit create, redelivery/cold readback, lost-ACK unknown without replay, project scope, trusted IPC/preload and no Provider/workflow effects |
| Negative controls | Existing route and exact-snapshot controls remain retained. Temporarily auto-creating a personal draft after model output fails two no-draft assertions; source restored byte-identically (`/tmp/scry-template-edit-candidate-negative.log`) |
| Production renderer/preload/Main, offline adapter | `scry-workflow-mode-app-mzj6G2/routing.json`: explicit edit = zero calls; targeted and targetless natural-language edits each route once; each explicit candidate adds one disclosed authoring call; exact candidate/archive cold-reopen; confirmed builtin candidate creates one personal editable draft with new identity; total 13 calls; builtin source unchanged |
| Narrow desktop viewport | Same App run: 430×760, no page/modal overflow, actual instruction style is pre-wrap; this is desktop responsiveness, not phone acceptance |
| Cold App observation | Same fixture: total 11 offline calls after existing mode/override scenarios, edit router and explicit candidate; another restart lists both edit Tasks and reads the same candidate/archive without another call |
| Adjacent production template editor | `scry-workflow-template-editor-ui-lcw6ZG`: builtin readonly, Save As, invalid draft retention/reopen, source/structure identity, full review, separate project consent, prepare/approval, deletion/restore, focus, narrow layout, native revisions and check/fix draft all pass |

Current logs include `/tmp/scry-template-edit-candidate-final-related.log`, `/tmp/scry-template-edit-application-build.log`, `/tmp/scry-template-edit-application-routing-app.log` and `/tmp/scry-template-edit-candidate-negative.log`. Earlier captured-Task logs remain applicable. No speed claim is made. `send.codex-fixture` and `providers.catalog` still have no counter collector and return status 1, not zero/pass. All fixtures use isolated userData/HOME/workspaces and the explicitly offline adapter.

## Fixture corrections retained

- `scry-workflow-mode-app-cylU4A` failed its pointer receipt after viewport restoration; the dialog remained open. No close was replayed in that instance. The probe now closes at the measured narrow viewport before restoring metrics.
- `scry-workflow-mode-app-dMLO3q` caught an earlier retained workflow draft being appended to the edit text. The hidden-window key alone did not select it. The probe now sends Chromium's native `selectAll` editing command, verifies the complete selection before typing, and requires exact multiline equality in both composer and instruction display. It does not set DOM values or weaken the instruction assertion.
- Fresh isolated fixtures `VPmris`, `f4tpgk` and the post-validator-extraction `zyCUoP` pass. Final evidence explicitly records `coldAfterEdit` at 10 calls. The first failures are not overwritten or counted as passes.
- The first v3 production App run rejected an explicit command because the full parsed edit command carried `kind`/`input` fields into the strict public selector. Main now projects only `templateId` and optional `scope`, then validates that object. Focused tests and current App `4ZSght` pass; the first failure remains `/tmp/scry-template-edit-task-routing-app.log`.

## Remaining (not claimed complete)

- Targetless v3 Tasks can now freeze an explicitly selected exact source in the separate candidate attempt while v3 remains immutable. Unknown or completed candidates can start a new explicitly confirmed attempt with a new identity; bounded candidate history is visible without loading prior source bodies. An unknown draft application can start a separate explicitly confirmed attempt that warns it may duplicate. Bounded draft-application history is visible on reopen; a recorded applied receipt blocks silent duplicate creation, while unknown explicitly warns that a new application attempt may duplicate.
- Draft review/edit/publish remains the existing explicit lifecycle. Candidate application is not publication or permission to execute.
- Actual semantic recognition and native Provider/account acceptance remain unverified. Scripted routing replies prove dispatch/provenance, not classifier accuracy.
- `research`, remaining M3–M6, general stall/restart and the original revision timeout failures remain open. Claude CLI stays excluded.
- No commit, push, installation, version bump or daily App restart. Main entry remains above the authored size cap.
