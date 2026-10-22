# A1 process identity measurement

- Path: provider launch/stop identity capture.
- Baseline source: `bf92d04` (the original pre-optimization tree).
- Candidate source: `443924a` plus Claude abort gate `bcf2952` and final event-driven collector `5bdc225` on `perf/handoff`.
- Scope: local child-process fixtures only. No Claude/Qoder provider, network, account, or paid work was used.

## Reproducible L1 collector

`src/main/process-identity-measurement.test.ts` starts `node -e 'process.stdin.resume()'` with an open stdin pipe as a detached child for three Claude-labelled and three Qoder-labelled spawn-equivalent samples. It calls the production `captureProcessIdentity(child.pid)` with its default lister. A pass-through `node:child_process` mock records the real executable, argv, whether the call is full-table or target-PID, and returned row count. The child group is killed and its exit is awaited before the fixture is cleaned up.

Run:

```bash
npx vitest run src/main/process-identity-measurement.test.ts --reporter verbose
```

The same test file was copied into an isolated worktree at `bf92d04` for the baseline run; it was not committed there. The recorded L1 results were:

```text
baseline bf92d04: 6 execFileSync /bin/ps calls; 6 full-table calls using
  [-axo, pid=,ppid=,stat=,lstart=,command=]; returned 720–725 rows each in the final event-driven fixture run;
  Claude 3 calls, Qoder 3 calls.
candidate: 6 execFile /bin/ps calls; 6 target calls using
  [-o, pid=,ppid=,stat=,lstart=,command=, -p, <child pid>]; returned 1 row each;
  Claude 3 calls, Qoder 3 calls.
```

The final fixture uses stdin readiness to keep its child alive, not a sleep or an enlarged timeout. Against original `bf92d04`, the new Claude stop tests fail 6 of 9 cases, including an unchecked child-handle SIGKILL for unknown identity. This negative control ran only against mocked child signalling; the real measurement child was stopped and its exit awaited.

The collector therefore measures the actual default implementation on both sides. It does not inject the baseline full-table lister into the candidate, and it does not include elapsed-time samples.

The earlier committed `samplesMs` values and any timings collected without the `timing-run.mjs` host lock are unlocked historical timings. They are not valid L2 evidence and must not be used as a user-timing claim. This follow-up reports only the reproducible L1 work/count change. No timing run was needed.

## Additional abort gate

Parent review found that Claude's native `spawn({ signal })` would let Node send SIGTERM before identity capture completed. The spawn callback now registers an abort listener through the same verified-identity gate as force-kill, removes it on child exit, and rechecks child exit state after awaiting capture. Pending/rejected/unknown capture, already-exited children, and resolved abort/force-kill paths have focused production-runner coverage. Qoder uses its explicit abort hook, now awaited through the identity Promise.

## Guardrails

- `readProcessSnapshot` full-table diagnostics remain out of scope.
- Identity capture and verification keep the same `LC_ALL=C` `lstart` format.
- Unknown, timeout, or failed identity must not send a signal, including direct child fallback.
- Baseline fixture cleanup verifies its own child exits before the temporary worktree is removed.
