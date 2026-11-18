# Scope and code correspondence

## Why this target and tool

Scry promises reciprocal exclusion between source-control writes and ordinary Agent admission. A violation can let a panel operation change the index, refs or files while a run still uses them. Tests of each method separately miss the check/register/snapshot ordering and the interval between Provider settlement and local finalization.

TLA+/TLC is appropriate because the question is event ordering, not arithmetic or memory safety. Release 1.7.4 (TLC 2.19, revision `5a47802`) is pinned by SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. Java 11+ runs it. The real TypeScript methods are additionally exercised with the repository's locked Vitest 3.2.7. This is **not** a proof that TypeScript refines the model.

Recorder crash consistency is a close second target, but needs a larger filesystem/locking/recovery contract. Command receipt deduplication was also inspected; it does not replace this repository-ownership property. Neither alternative was verified or diagnosed by this skill.

## Finite scope

- One normal `admitRun` attempt and one panel `mutate` attempt, each at most once.
- One optional unrelated, already-held gate; it may be released at any point, but no new unrelated operation begins. This exposes `admitRun`'s asynchronous identity path without pretending every admission takes that path.
- Five identity classes: `shared` (same root **or** a linked worktree with equal `commonDir`), `other`, `unknown` cwd, positively `notRepository`, and `identityError`.
- A run may be running, Provider-settled/local-finalizing, or fully finished. `done` alone is not ownership release.
- Identity results and repository equality stay stable. No external process mutates the filesystem. The main process executes synchronous JavaScript without preemption.
- All reachable transitions of this finite model are explored; no depth cut, symmetry reduction or search-state constraint is used. TLC uses standard state fingerprints, not an unbounded mathematical proof.

The baseline has 10 initial states and 432 distinct reachable states at the recorded sync revision. Changing this count is a review signal, not automatically a regression. Do not hardcode it as a passing threshold.

## Source mapping and indivisible steps

| Model transition / value | Production source | Atomicity and abstraction |
| --- | --- | --- |
| `BeginRun` | `SourceControlService.admitRun` | Empty `active` → `register()` has no await; treat as one transition. With an active gate, unknown cwd rejects; otherwise identity resolution yields. |
| `ResolveAdmission` | `admitRun`, `ScGit.identity`, `isNotRepository` | After identity awaits, final `active.has(commonDir)` and synchronous `register()` are one JS turn. A recognized non-repository may register; unexpected errors reject. |
| `AcquireWriteGate` | `exclusive` | Queue waiting precedes `active.add(commonDir)`; only acquisition is the modeled state change. |
| `CaptureUnsettled` | `mutateExclusive` → `busy`, `index.ts` wiring | The gate is already held. `runs.unsettledStates().map(run => run.cwd)` captures one synchronous snapshot; later awaits do not replace it with a fresh list. |
| `ResolveBusy` | `busy` | For the captured cwd, Git identity may yield. Equal commonDir or unknown cwd blocks; other/non-repository does not. Identity errors fail the operation before dispatch. |
| `DispatchMutation` | `mutateExclusive` → `executeMutation` | The running operation journal save yields before dispatch, while the gate stays held. Model `saving` exposes this gap. |
| `MutationReturns`, `ReleaseWriteGate` | awaited action, `exclusive` finally | The gate is not released until the action returns/throws. A separate release transition permits scheduling at the real await boundary. |
| `Exposed` | `RunRegistry.unsettledStates` | `providerSettled !== true || localFinalizing === true` determines occupancy. |
| `ProviderSettles` | `run-execution.ts`, settlement `onProviderSettled` callback | `providerSettled = true` and `localFinalizing = true` are adjacent synchronous assignments. They do not expose an intermediate unowned state. |
| `FinishLocalWork` | `run-settlement.ts`, `finalizeSettledRun` | After awaited local work, `runs.remove(runId)` and `localFinalizing = false` are synchronous. Failure before removal retains ownership. Waiting/failure is modeled by remaining finalizing; no liveness claim is made. |
| actual registration | `startRunProviderAndRegister` in `bootstrap/run-startup.ts` | Its ordinary branch calls `sourceControl.admitRun(cwd, register)`; `register` synchronously calls `runs.register`. The `workspaceAdmission` branch is excluded. |
| `PreflightFails` | store/identity/cancellation errors before execution | Such failures cannot dispatch. Individual awaits with no modeled state changes are abstracted as stuttering, not as a single atomic block containing registration or gate release. |

The model's “writing” interval is conservatively the whole `executeMutation` call. It may include checks that do not write. Proving no overlap over that larger interval is stronger than covering only an individual Git command, under the stated bounds.

The store's prior-operation/unresolved-journal checks, trust checks, branch fingerprints and OS calls are not proved. The baseline assumes a fresh valid authorized request; pre-dispatch errors may stop it. Modeling those paths as “no dispatch” does not assert recovery or authorization correctness.

## Real-code witnesses and setup boundaries

`scripts/source-control-exclusion.formal.test.ts` imports the actual `SourceControlService` and `RunRegistry`. It uses temporary real `ScStore` files. Git identity is a deterministic dependency fixture; the identity cache normally filled by `read()` is seeded, and `executeMutation` is intercepted at the external-write boundary. The gate methods, busy logic, registry and their awaits are **not replaced**.

The two exact shortest-path tests pause the real `store.get` await after gate acquisition. One resolves admission identity after the synchronous busy snapshot; the other changes Provider/local-finalization state after gate acquisition and before that snapshot. Promise continuations then run normally. No `await` is inserted into the protected atomic check/register section.

The remaining witnesses cover both same-root and linked-worktree admission, running/finalizing/unknown occupancy, unrelated-repository progress and release after finalization. These examples connect the model to code; they do not enumerate every TypeScript schedule.

## Updating the check

1. Read `coverage.json` and diff its `syncCommit` against the target revision for the eight covered files. Review relevant dirty changes too. The helper rejects changed covered bytes before running TLC.
2. Trace callers, `await` boundaries and shared `commonDir` identity again. For unrelated edits in a covered file, confirm the protected methods and wiring still mean the same thing. Do not silently expand the proof to workspace admission or external writers.
3. If behavior is intentionally changed, first decide whether the plain-language promise still holds. Update the model, source mapping and real-code witnesses together. If an invariant fails on current code, preserve the counterexample and request authorization before any product fix.
4. Confirm both real-code scratch mutations are still meaningful, with exactly one matching source span each. The checker requires the corresponding **shortest-path** test to fail with `NoWriteDuringUnsettled`, not merely a nonzero process exit.
5. Only after correspondence review, update `syncCommit` in `SKILL.md` and `coverage.json`, and recompute SHA-256 for the covered files. The sync commit must be an actual existing code revision, never a guessed future commit. Dirty target code needs its reviewed hashes recorded and an explicit dirty-evidence note until committed.
6. Run the one-command check. Use `/statechart` for the baseline and each negative config. Read any additional unchecked-rule/error notices, not just exit codes. Reproduce new bug traces against the real methods.
7. Ensure restored witnesses pass, original source hashes are unchanged, scratch is gone and evidence remains. Report scope and any tool/version/identity assumptions that changed.

## Evidence and cleanup

The helper prints an absolute `scry-formal-evidence-*` directory. It retains the model/config copies, witness source, checker hash, baseline/control/restored logs, Vitest JSON reports, revision/dirty evidence, tool versions, elapsed time and `result.json`. Scratch source copies are separate and removed in `finally`; the original checkout is hash-checked again after successful execution.

The helper performs real-code mutations only in `scry-formal-source-*`, with shared `node_modules` linked read-only by convention. The tests themselves create and delete separate temporary stores. There is no App process, Provider, Git mutation or network call in the tests. Only the first verified TLC download needs network access. Keep logs after failures; a `passed` summary is not an invitation to delete counterexample evidence.

TLC artifacts and statechart output may contain local paths. Keep them outside Git. Copy evidence to durable task storage if it must outlive OS temp cleanup.
