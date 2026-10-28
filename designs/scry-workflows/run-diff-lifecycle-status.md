# Main run diff lifecycle extraction

This is a cohesive Main decomposition checkpoint, not M1–M6 completion. `app-run-diff.ts` owns the existing run-scoped turn/session Git diff lifecycle; it does not introduce another diff state, execution owner or settlement path.

## Boundary

The 9,650-byte helper owns:

- retaining the session baseline and cloning the first turn from the same instant;
- clone-failure fallback to the existing full capture;
- running bounded turn/session previews from the existing captures and live journal hints;
- sealing all preview scopes before terminal consumption;
- pairing turn and session projections on one terminal after-tree when possible;
- publishing turn/session trace evidence, including honest unavailable reasons;
- memoized finalize/cancel calls and returning the physical baseline release handle.

Main still owns the initial capture start and recorder exclusion read, live session promotion, run registration, startup barrier, Provider execution, archive settlement, `runs.remove`, and the physical release point between run removal and settled resolution. The helper receives live identity/revision/hint getters and narrow publication callbacks. Terminal publication continues to use `isViewed`; temporary preview publication continues to use `isFocused`.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck/build | Passed | `/tmp/scry-app-run-diff-final-validation.log`; both tsconfigs, 350 Main modules, Main 2751.68 kB, preload 28.49 kB |
| Real-Git focused regressions | 3 files / 52 tests passed | New tests invoke the actual returned preview/finalizers; existing `session-diff` and `git-terminal-pair` retain throttling, trailing refresh, clone/shared-after ownership, cleanup and degraded evidence contracts |
| Dynamic identity | Passed | Promotion to the native session yields paired captured turn/session snapshots; changing to an unowned identity yields `no_baseline`, not stale reuse |
| Publication boundary | Passed | Focused previews are queued; terminal evidence is queued while viewed after focus is gone; post-seal notify/finalize calls do not add events |
| Negative control | Failed as intended | Freezing the initial diff key makes both live-identity controls fail; helper restored byte-identically. `/tmp/scry-app-run-diff-live-identity-negative.log` |
| Production App | Passed | Routing `scry-workflow-mode-app-N74pkr`; native workflow/Node/output/cold read `scry-workflow-node-stop-app-b14aBh` |
| Catalogue contract | 3 files / 20 tests passed | Helper is listed for send, controls, persistence and source-control. `/tmp/scry-app-run-diff-catalogue.log` |
| Performance collector | Unavailable, status 1 | `send.codex-fixture` still has no counter collector. `/tmp/scry-app-run-diff-performance.log`; not zero/pass and no speed claim |

The first new test failure assumed an exact repository-relative file path. Real Git evidence used a canonical path ending in `tracked.txt`; the assertion was corrected to verify that canonical suffix. Production code, workload, assertions of behavior and deadlines were unchanged.

The App timing wrappers reported high host load. Their functional exit status is evidence for the fixture behavior, not a millisecond performance conclusion. Registered fixture resources closed; escaped descendants and remote effects are not proven closed.

## Current limits

- Main is 158,905 bytes and remains the only changed/untracked authored file over 20,000 bytes after this documentation split.
- Original revision timeouts/`ENOTEMPTY`, the expanded history timeout and earlier catalogue aggregate failures remain. The current focused catalogue pass does not erase them.
- No real Provider/SDK/account or Jev fee acceptance. Claude CLI remains excluded.
- No commit, push, install, version change or daily App restart.
