# A1 process identity measurement

- Path: `providers` launch/stop identity capture.
- Baseline commit: `c453281`.
- Candidate/optimization commit: `fabced4`.
- Scope: local child-process fixtures only. No Claude/Qoder provider, network, account, or paid work was used.

## Reproducible harness

`src/main/process-identity-measurement.test.ts` starts `/bin/sh -c 'sleep 2'` as a detached child for three Claude-labelled and three Qoder-labelled spawn-equivalent samples. It wraps the production `captureProcessIdentity` lister and counts each process-list invocation. The child process group is killed in test cleanup.

Run:

```bash
npx vitest run src/main/process-identity-measurement.test.ts --reporter verbose
```

The repository's provided `node_modules` symlink currently points at an install whose `vitest` package has no `package.json`, so the test runner could not load `vitest/config` in this worktree. The equivalent production baseline was run with the Node harness below instead; it uses the same `/bin/ps -axo pid=,ppid=,stat=,lstart=,command=` call and `LC_ALL=C` environment used by the current implementation.

```bash
node --input-type=module <<'NODE'
import {spawn, execFileSync} from 'node:child_process'
import {performance} from 'node:perf_hooks'
const samples={claude:[],qoder:[]}, calls={claude:0,qoder:0}
for (const provider of Object.keys(samples)) for(let i=0;i<3;i++) {
 const child=spawn('/bin/sh',['-c','sleep 2'],{detached:true,stdio:'ignore'})
 const started=performance.now()
 try {
   calls[provider]++
   const output=execFileSync('/bin/ps',['-axo','pid=,ppid=,stat=,lstart=,command='],{encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,LC_ALL:'C'}})
   if (!output.includes(String(child.pid))) throw new Error('child not found')
   samples[provider].push(Number((performance.now()-started).toFixed(3)))
 } finally {try{process.kill(-child.pid,'SIGKILL')}catch{}}
}
console.log(JSON.stringify({command:'captureProcessIdentity equivalent',calls,samples}))
NODE
```

Observed on this macOS host before optimization:

```json
{"command":"captureProcessIdentity equivalent","calls":{"claude":3,"qoder":3},"samples":{"claude":[68.495,38.07,37.335],"qoder":[36.005,36.718,43.113]}}
```

The committed Vitest harness was also rerun after the optimization commit. Its wrapper intentionally retains the baseline full-table lister so the historical count remains reproducible:

```text
A1 baseline {"command":"captureProcessIdentity at controlled Claude/Qoder spawn","measurements":[{"provider":"claude","samplesMs":[54.604,49.538,46.336],"psCalls":3},{"provider":"qoder","samplesMs":[51.61,43.268,43.606],"psCalls":3}]}
```

This is L1 evidence: six full-table `ps` calls for six controlled spawn-equivalent captures. The sample durations are controlled local measurements, not an L2 user timing claim; no timing-run lock was used because the result is reported as a work/count baseline. Before `fabced4`, the implementation synchronously scanned the complete process table for each capture, while both launch sites needed one PID identity. The candidate now starts one asynchronous targeted lookup per spawn and keeps the full-table diagnostic verifier unchanged.

## Guardrails

- `readProcessSnapshot` full-table diagnostics remain out of scope.
- Identity capture and verification must keep the same `LC_ALL=C` `lstart` format.
- Unknown, timeout, or failed identity must not send a signal, including direct child fallback.
