---
name: verify-source-control-exclusion
description: Check Scry repository write/run exclusion when admission, mutation gates, unsettled tracking or wiring changes. Uses bounded TLA+ and real-code replays; not UI, Provider acceptance, crash recovery or whole-app proof.
---

# Verify repository write/run exclusion

**Promise:** a panel Git mutation must not dispatch while an ordinary registered Agent run still owns the same repository, including local finalization after Provider completion.

**Harm:** overlap can change files or the Git index underneath the Agent and invalidate commit/diff evidence.

## Run

From the Git root, with the locked npm dependencies, Node >=22.12 and Java >=11:

```sh
node .agents/skills/verify-source-control-exclusion/scripts/check.mjs
```

Use `npm ci` if dependencies are missing. The executable helper caches checksum-pinned **TLC 1.7.4** and uses locked **Vitest 3.2.7**. No App, Provider or Git writes. Read [scope and mapping](references/coverage.md).

Checks the model and 11 witnesses, removes two guards in **temporary code copies**, requires shortest-path failures, restores copies, then requires 11/11. Scratch is deleted; `EVIDENCE=...` retains results. Exit 0 covers this bound only.

## Read every result with /statechart

Use **`/statechart`** for every TLA+ result, including controls. Read its installed skill for current commands; do not copy them here. It draws passing states and shortest violation paths. [Interpretation](references/interpretation.md) contains charts and replayed traces.

A baseline violation is a finding. Replay it against real code; an impossible trace suggests model/atomicity drift. Never weaken the property or change product code without authorization. Tool errors are not counterexamples.

## Coverage and synchronization

Last code correspondence review: **`efc650597ae694fcd83f9346c7a8bd1725176512`**.

| Covered file | Covered functions / responsibility |
| --- | --- |
| `src/main/source-control/service.ts` | `admitRun`, `exclusive`, `busy`, `mutate`, `mutateExclusive` |
| `src/main/run-registry.ts` | `register`, `unsettledStates` |
| `src/main/source-control/git.ts` | `identity`, `isNotRepository` assumptions |
| `src/main/source-control/mutation.ts` | `executeMutation` dispatch boundary |
| `src/main/bootstrap/run-startup.ts` | ordinary registration through `admitRun` |
| `src/main/index.ts` | unsettled-directory wiring |
| `src/main/bootstrap/run-{execution,settlement}.ts` | settlement callback and `finalizeSettledRun` |

Changed `coverage.json` hashes cause `REVIEW_REQUIRED`. Follow [the update procedure](references/coverage.md#updating-the-check); advance both sync records only after reviewing correspondence. Never refresh hashes just to unblock execution.

## Bounds and limits

Bounds: one admission, one mutation, one optional unrelated gate, five identity classes. Same-root/linked worktrees share `commonDir`. Stable identities; one JS event loop.

Excluded: workspace-start reservation handoff, multiple runs/writers, external processes/Git, identity replacement, crash durability, path/trust checks and real Providers. This verifies the bounded model, not TypeScript refinement or all code schedules.

Use `/maintain-formal-verification-skill` after relevant changes that did not rerun this check.
