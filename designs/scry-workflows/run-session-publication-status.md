# Main run session publication extraction

This is a cohesive Main decomposition checkpoint, not M1–M6 completion. `app-run-session-publication.ts` owns the synchronous provisional-to-native session identity publication sequence. It does not own Provider dispatch, selected-session authority, run registration, settlement or physical release.

## Boundary

The 5,279-byte helper preserves the existing order:

1. persist current/pending catalog ownership before attachment bytes;
2. prepare attachments and the Provider prompt;
3. publish the initial renderer identity for non-workflow runs;
4. when a Provider reports a native session, update run-local identity;
5. notify remote/workflow consumers before renderer deduplication;
6. promote the Git diff baseline;
7. call Main's revision-gated selected-session commit;
8. rekey badge and attachment ownership;
9. record the native session and publish the renderer event.

Initial publication failures still run provisional catalog cleanup and attachment deletion, preserving the original front-door error. Attachment-owner, native-catalog and terminal renderer publication errors remain non-fatal warning paths after native identity is known.

Main retains the session revision predicate and maps, Provider callback registration, terminal fallback call, execution/settlement, startup barriers and release ordering. The helper receives narrow callbacks for those authority decisions; it does not receive the App, Provider registry, run registry or an omnibus runtime context.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Node/web typecheck | Passed | `/tmp/scry-app-run-session-types.log` |
| Focused contracts | 8 files / 126 tests passed | Session publication, run diff, session diff, badge, attachment store, App store, Pi lifecycle and fake-provider integration. `/tmp/scry-app-run-session-session-tests.log` |
| Parallel/stop adjacent contracts | 4 files / 30 tests passed | Failure policy, node-stop contract/journal and parallel stop. `/tmp/scry-app-run-session-parallel-focused.log` |
| Production build | Passed | 351 Main modules; Main 2753.96 kB, preload 28.49 kB. `/tmp/scry-app-run-session-build.log` |
| Negative control | Failed as intended | Freezing every promotion at the provisional diff key fails the duplicate live-promotion assertion; source restored byte-identically. `/tmp/scry-app-run-session-publication-negative.log` |
| Production routing App | Passed | Actual Main/preload/renderer with isolated offline adapter: `scry-workflow-mode-app-fHAnGn`. `/tmp/scry-app-run-session-routing-app.log` |
| Performance catalogue | 3 files / 20 tests passed | New helper is classified under send, controls, persistence and source-control. `/tmp/scry-app-run-session-catalogue.log` |
| Counter measurement | Partial | `persistence.archive` and `source-control.diff` ratchets pass; `send.codex-fixture` and `controls.stop-lifecycle` have no collector and return status 1, not zero/pass. All wrappers reported high load, so no millisecond claim. `/tmp/scry-app-run-session-performance-*.log` |

The full native workflow/Node/output App probe did **not** pass this checkpoint. It timed out waiting for a user-stopped trigger and automatically stopped sibling to physically converge under host load 198 on ten cores (`scry-workflow-node-stop-app-QC7tXH`). The failure is outside this helper's session-publication assertions; focused stop contracts pass, but that does not reclassify the production App failure. No timeout or workload was changed and the App write was not replayed. Fixture cleanup left no matching target process; escaped descendants and remote effects are still not proven.

## Current limits

- Main is 157,962 bytes. The extraction removes 943 bytes from Main while placing the identity lifecycle in a 5,279-byte focused module; Main remains the only changed/untracked authored file over 20,000 bytes.
- The original revision/`ENOTEMPTY`, expanded history and earlier catalogue aggregate failures remain.
- No real Provider/SDK/account or Jev fee acceptance. Claude CLI remains excluded.
- No commit, push, installation, version change or daily App restart.
