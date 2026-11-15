----------------------- MODULE RepositoryExclusion -----------------------
EXTENDS Naturals
CONSTANTS RunKinds, BreakAdmission, BreakFinalization
VARIABLES runKind, run, writer, gate, otherGate, snapshot
vars == <<runKind, run, writer, gate, otherGate, snapshot>>

\* One ordinary admitRun, one panel mutate, one unrelated pre-existing gate.
\* Shared covers both the same root and linked worktrees with equal commonDir.
\* Other roots have a different commonDir. Identities stay stable.
Conflicts == runKind \in {"shared", "unknown", "identityError"}
Unsettled == run \in {"running", "finalizing"}
Exposed == run = "running" \/ (run = "finalizing" /\ ~BreakFinalization)
RunGateHeld == IF runKind = "other" THEN otherGate ELSE gate

Init == /\ runKind \in RunKinds
        /\ run = "new"
        /\ writer = "new"
        /\ gate = FALSE
        /\ otherGate \in BOOLEAN
        /\ snapshot = "none"

\* admitRun fast path has no await before register(). Otherwise identity awaits.
BeginRun ==
  /\ run = "new"
  /\ run' = IF ~gate /\ ~otherGate THEN "running"
             ELSE IF runKind = "unknown" THEN "rejected" ELSE "resolving"
  /\ UNCHANGED <<runKind, writer, gate, otherGate, snapshot>>

\* The final active.has(commonDir) check AND register() are one JS turn.
ResolveAdmission ==
  /\ run = "resolving"
  /\ run' = IF runKind = "identityError" THEN "rejected"
             ELSE IF runKind = "notRepository" THEN "running"
             ELSE IF BreakAdmission \/ ~RunGateHeld THEN "running" ELSE "rejected"
  /\ UNCHANGED <<runKind, writer, gate, otherGate, snapshot>>

ProviderSettles == /\ run = "running"
                   /\ run' = "finalizing"
                   /\ UNCHANGED <<runKind, writer, gate, otherGate, snapshot>>
FinishLocalWork == /\ run = "finalizing"
                   /\ run' = "finished"
                   /\ UNCHANGED <<runKind, writer, gate, otherGate, snapshot>>
ReleaseOtherGate == /\ otherGate
                    /\ otherGate' = FALSE
                    /\ UNCHANGED <<runKind, run, writer, gate, snapshot>>

\* exclusive's queue wait completes before synchronous active.add(commonDir).
AcquireWriteGate == /\ writer = "new"
                    /\ writer' = "preflight"
                    /\ gate' = TRUE
                    /\ UNCHANGED <<runKind, run, otherGate, snapshot>>
\* store.get/unresolved awaits have no modeled side effects. Capture follows them.
CaptureUnsettled == /\ writer = "preflight"
                    /\ writer' = "checking"
                    /\ snapshot' = IF Exposed THEN runKind ELSE "none"
                    /\ UNCHANGED <<runKind, run, gate, otherGate>>
\* busy snapshots cwd, then awaits identity; settlement does not erase that snapshot.
ResolveBusy == /\ writer = "checking"
               /\ writer' = IF snapshot \in {"shared", "unknown", "identityError"}
                             THEN "blocked" ELSE "saving"
               /\ UNCHANGED <<runKind, run, gate, otherGate, snapshot>>
\* store.save yields before executeMutation; gate remains held throughout.
DispatchMutation == /\ writer = "saving"
                    /\ writer' = "writing"
                    /\ UNCHANGED <<runKind, run, gate, otherGate, snapshot>>
MutationReturns == /\ writer = "writing"
                   /\ writer' = "complete"
                   /\ UNCHANGED <<runKind, run, gate, otherGate, snapshot>>
\* Errors before dispatch cannot write. Finally releases only this operation's gate.
PreflightFails == /\ writer \in {"preflight", "checking", "saving"}
                  /\ writer' = "blocked"
                  /\ UNCHANGED <<runKind, run, gate, otherGate, snapshot>>
ReleaseWriteGate == /\ writer \in {"blocked", "complete"}
                    /\ writer' = "done"
                    /\ gate' = FALSE
                    /\ UNCHANGED <<runKind, run, otherGate, snapshot>>
Done == /\ writer = "done" /\ run \in {"finished", "rejected"} /\ ~otherGate
        /\ UNCHANGED vars

Next == BeginRun \/ ResolveAdmission \/ ProviderSettles \/ FinishLocalWork
        \/ ReleaseOtherGate \/ AcquireWriteGate \/ CaptureUnsettled \/ ResolveBusy
        \/ DispatchMutation \/ MutationReturns \/ PreflightFails \/ ReleaseWriteGate \/ Done
Spec == Init /\ [][Next]_vars

\* Plain promise: no panel Git dispatch overlaps a same-repository unsettled run.
NoWriteDuringUnsettled == ~(writer = "writing" /\ Unsettled /\ Conflicts)
=============================================================================
