# Recent Scry regression checks

## Repeatable commands

```sh
npm run test:regressions   # Focused unit/contract tests, then the hidden React UI fixture
npm run test:renderer:ui  # Hidden UI fixture only; no packaging or Provider required
npm run typecheck
npm test
npm run build
```

The UI fixture bundles the production PinnedSummary and OverviewPanel, using the installed
Electron development dependency. It never starts Scry main/preload, connects a Provider,
uses normal userData, or opens a visible window. It blocks external requests, disables window
opening, and preserves sandbox/context isolation. On macOS it prohibits app activation.
Temporary HOME/userData are removed after the child process closes. DOM transitions wait on
MutationObserver conditions; timeouts are deadlock watchdogs, not speed assertions.

## Incident → regression boundary

| Incident | Test | What would fail |
| --- | --- | --- |
| Qoder uses `/rate-native-hsf-invoke` but Skill reads as zero | `src/renderer/session-capability-contract.test.tsx` + `src/renderer/__fixtures__/session-capabilities.ts` | SDK-shaped Read + result normalized and serialized like an archive must yield one inferred Skill load, one MCP call and two total logical calls; raw events remain tools |
| Inferred Skill borrows an unrelated success or changes with duplicate order | `src/renderer/skill-load-evidence.test.ts` | Cross-run/subagent/tool/non-tool responses cannot confirm a load; partial duplicates cannot erase success; contradictory outcomes cannot prove success |
| Summary and Overview disagree or click the wrong evidence | `scripts/session-capability-ui-smoke.mjs` | Both real React components count consistently; three actual DOM clicks return original Read/MCP events; collapse, new session, pending→success, failed session and multi-turn reload remain consistent |
| Failed startup leaves a permanent recovery gate | `src/main/trace-turn-progress.regression.test.ts` | Failed/cancelled/interrupted without Provider evidence are cleared only in the matching scope; each independent Provider/fork/content/tool veto preserves the original bytes; completed empty turns are not discarded |
| autoGrant skips validation | `src/main/commit-hook-trust.regression.test.ts` | Traversal, symlink, unlisted entry and size violations reject before grants/bundles exist; tampered frozen content rejects rather than being silently replaced |
| Provider is done but App completion waits for callback backlog | `src/main/managed-turn-notifications.test.ts` | With only downstream drain blocked, App live commit and journal replay must durably archive/record and clear their artifacts before release; subsequent delivery rejection cannot undo completion |
| CLI/recovery accidentally adopts App detach semantics | `src/main/managed-turn-notifications.test.ts` | Core recovery defaults to awaiting delivery, explicit detach returns while blocked, bounded batch options propagate, and rejection semantics stay distinct |

The focused command also reruns existing session admission, archive/view reset, empty-history,
dock-permission and capability-call tests. These existing cases are not claimed as newly added.

## Evidence from this task (2026-09-08)

- Added **30 Vitest cases**, plus the hidden React interaction fixture.
- Before the inference fix, six newly added negative/ordering cases failed against the prior implementation.
- After the fix: focused suite **278 passed**; hidden UI fixture passed.
- Current working tree: **1749 passed / 3 skipped**, shell test passed; typecheck and build passed.
- CLI release checks: **487 passed**, CLI package smoke passed.
- Independently checked the staged snapshot (without unrelated working-tree edits, sharing installed dependencies): **1734 passed / 3 skipped**, shell test, typecheck and build passed; focused suite **269 passed** plus the hidden UI fixture.
- That independent full run also exposed a test cleanup race. The real-callback tests now wait for both the durable ACK and notification-lock release before removing their temporary workspaces, instead of treating callback output as delivery completion.

The normalizer/serialization contract is not a live Qoder test. The UI fixture proves component
callbacks, not the full App session navigation/IPC or native sidebar hit geometry. Downstream
delivery is mocked only for ordering tests; those tests do not prove remote delivery, ACK
migration or continuous queue draining. Stable notification receiver/cursor optimization remains
outside this change. No installed App restart, real Provider request, real record/ACK modification,
version bump or release is part of this test task.
