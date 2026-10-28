# Restricted workflow authoring: partial M2 checkpoint

This connects the existing App planning call to a private Main authoring purpose and canonical structured-result channel. It does not complete M2 or M1–M6.

## Implemented boundary

- Main alone selects `workflow_authoring`. Renderer input cannot set that purpose. Main requires an explicit adapter declaration, a fresh default-permission context, and no attachments, history reader, resume, fork, restart, replica authority or prompt override.
- Claude maps that purpose to the existing restricted SDK option builder: empty host tools, filesystem settings sources, MCP, plugins, skills and hooks; hooks and automatic memory disabled; fixed system prompt, JSON-object schema, one turn and deny-all host-tool permission callback. Ordinary execution retains its existing options.
- This is a **configured SDK contract**, not proof of native enforcement, account availability or OS isolation. Real Claude CLI validation is excluded at the user's request. Other production adapters do not inherit this declaration.
- Planning uses the same App executor and workflow slot/intent chain. It accepts only a successful terminal's matching canonical result source, authoritative result event and committed archive reference. Assistant text is never a planning fallback. The existing compiler remains authoritative for the recursive program grammar, roles, paths and execution limits.
- Candidate authoring does not start a workspace Recorder or commit callback. It retains App trace/usage evidence. The existing App trace content policy (8 KiB per field, 128 KiB per turn) is explicitly pinned through progress, archive and SQLite/outbox sinks. Ordinary workspace capture configuration still fails closed. No Recorder Core implementation was changed.
- Planning intents persist `outputSource` with the canonical output reference and archive reference. Legacy records without that metadata are not relabelled. Approved worker execution remains unchanged.

## Verification

Evidence root: `/tmp/scry-workflow-task-entry.V7ObQf/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web types, affected tests, build | Pass: 21 files, 257 tests | `workflow-authoring-final-gates.log`, `workflow-authoring-final-test-files.json` |
| Canonical result vs assistant shadow | Deliberately substituting assistant text fails; source restored | `workflow-authoring-shadow-negative.log` |
| Actual Main Recorder guard | Removing the purpose guard fails before Provider dispatch on malformed Recorder configuration | `workflow-authoring-guard-negative-app.log`, `workflow-authoring-guard-negative-result.json` |
| Capture policy and recovery | Real temporary files prove ordinary malformed configuration is rejected, while an explicit App policy remains bounded across progress recovery and outbox retry | `workflow-authoring-archive.test.ts`, `db-outbox.test.ts` |
| Production preload/Main IPC with synthetic Provider | Pass: two concurrent plan requests produce one candidate call, zero dispatched workers, awaiting approval, canonical fixture provenance, unchanged workspace records, restored Recorder config and unchanged cold-observation metadata/output | `workflow-authoring-pinned-app.log`, scene `scry-electron-smoke-yo5ovH` |
| Independent archive inspection | Completed planning archive contains the pinned App capture budget | `workflow-authoring-pinned-archive-proof.json` |

The final App run also retains the six original ownership refusals, positive legacy controls, direct-task deduplication, the late dispatch fence, and startup-failure/cold-observation checks. Its five synthetic Provider calls are fork + legacy run + two direct tasks + one planning call. No generated worker was executed.

The App fixture deliberately returns `scry_fixture_success_result`, never SDK provenance. Mocked runner/adapter tests verify configuration and canonical forwarding; neither they nor this App fixture prove real native host-tool enforcement.

## Retained failures and identity limits

- Initial typechecks rejected an impossible `settled: false` terminal fixture and an image missing its required kind. The tests were corrected to the actual contracts; the unsettled case instead exercises a real post-dispatch launch exception.
- The first successful App case had no malformed Recorder challenge. It proves canonical forwarding but does not independently prove the Recorder guard.
- The first malformed-config positive challenge failed with a settled `unknown` terminal. Startup isolation alone was insufficient: terminal capture still resolved workspace policy. The explicit App policy fixes that boundary; the failed scene `scry-electron-smoke-ekh8lC` and its build remain retained.
- The final run's attempted pre-run manifest assertion had an incorrect expected changed-file set. The shell continued into the authorized App test, which passed. The corrected identity manifest is explicitly **post-run**, not a reconstructed pre-run observation. The App test was not repeated to repair metadata.
- This checkpoint's Main artifact: `de3e908819c7e0b049b4d4a790ba88d4304dc9a8db9b9d5ad140564d12a1d4e4`; preload: `b7f29dbcf075eaf71edf6adb6ab015cf122d1bb8408bb040f6077b147629eadb`. See `workflow-authoring-pinned-app-identities.json` for scope. The deliberate negative binary was copied before rebuilding and is not the current output.
- Registered cleanup helper return is not proof about escaped descendants or remote effects. Timing metadata is not a speed or load-causation claim.

## M2/M3 offline contract update

The preview now carries explicit structured-candidate, host-tool, permission-question, business-question and model/tool/quota observation states. Missing adapter declarations remain unavailable or unknown; they are not promoted to support. Runtime fingerprints include the authoring and observation inputs. A main-owned, opt-in settled-scope evidence callback can authorize at most five stalled-attempt restart generations without resetting the frozen program or root budget; explicit retry remains separate. These are offline contract tests only and do not validate a real Provider, account or quota service.

## Still open

Main-owned generic Workflow/template task association, manual/auto policy with live fee/data authorization, one combined route-and-plan call, production native command execution, authoring-availability UI and remaining M3–M6 work are not completed here. Prior SystemStep/recovery/TAP/unified-suite deadline failures remain unresolved; they were not retried or declared unrelated. Real SDK enforcement remains unverified and Claude CLI execution stays excluded.

No commit, push, installation, version bump, daily-App restart, real Provider/account/model/Jev call or business-workspace write was performed. `index.ts` remains over the authored-file size limit and requires responsibility splitting before staging.
