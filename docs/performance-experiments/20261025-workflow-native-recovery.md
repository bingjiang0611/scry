# Native recovery: verified artifacts, fingerprint chunks and group absence

## Scope and experiment authorization

Only `/Users/baobingjiang/IdeaProjects/vibecoding/scry-workflow-m0`, local synthetic fixtures and current-source tests were used. No real Provider/Jev call, business workspace, installation, push, version bump or daily-App restart occurred.

The earlier second bounded round had one remaining experiment: remembering successfully verified cold governing artifacts. It was used here. Because that did not close the original 5000ms native-process timeout, the user explicitly authorized **up to three additional experiments**. Two were used: fingerprint stream chunks and kernel process-group absence. One remains unused. Do not infer permission for an unlimited performance search.

Collectors were committed independently before their corresponding optimizations:

- `888466dd`: cold governing publications.
- `9adc089a`: executable fingerprint stream chunks/bytes.
- `ad56b9be`: group-list calls, with an unchanged mechanical extraction of the existing PID identity/group census functions. This extraction also keeps the edited check module below the task's 20,000-byte authored-file limit.

These metrics are diagnostic/unregistered. The canonical ratchet, ceilings and workloads were not changed. `providers.catalog` still has no matching official collector; its measurement is unavailable, not zero/pass.

## Hypotheses and fixed workloads

| Hypothesis | Fixed observed operation | Five baseline → candidate observations |
| --- | --- | --- |
| Cold `load` verifies immutable governing files, but the next publication unnecessarily rewrites them | One completed root, two canonical revisions, zero Agent attempts, real FileStore; cold load and one root save | Governing publications `[2,2,2,2,2]` → `[0,0,0,0,0]`; root publications remain `[1,1,1,1,1]` |
| Default 64KiB stream chunks cause avoidable hashing/iterator work on the Node executable | One real `freezeWorkflowCheck`, current canonical Node executable, concrete replica entrypoint, independent complete SHA-256 comparison | Delivered chunks `[1846,1846,1846,1846,1846]` → `[116,116,116,116,116]`; bytes remain `120965360` in every observation |
| A physically absent registered group can be proved without starting a full process-list command | One actually registered local Node group, child close observed; one production group-absence query | `/bin/ps` group-list calls `[1,1,1,1,1]` → `[0,0,0,0,0]` |

Each component has an added-real-work sensitivity case: an additional root publication, an additional complete approval, or an additional actual process-list command increases its observed work. The collectors call production implementations and assert the functional result. They do not replace the unchanged OS-controller acceptance workload or move its setup outside the test.

## Changes and preserved boundaries

### Existing verified artifacts

`FileWorkflowStore.load` remembers content addresses in the existing bounded 1024-entry publication cache **only after** digest, root ownership, identity and stop-receipt validation succeeds. Each load still reads and hashes governing bytes. A corrupt or missing artifact is rejected even after a previous successful load. No new cache, payload authority or guessed fallback was added.

A later root publication still flushes the root file, atomically renames it and synchronizes the directory before acknowledgement. New governing artifacts retain their original durable publication. Content-addressed revision bytes, CAS and historical budgets are unchanged. Invalid or orphan artifacts are not an accepted root.

Tests hold the real directory sync and prove no acknowledgement; inject a sync failure and prove rejection; mutate bytes after caching and prove every load still rejects; and reject a root after hashing and prove no cache admission occurred. Deliberately moving admission before root validation fails the new regression.

### Complete executable fingerprint

`fingerprint` uses `createReadStream(..., { highWaterMark: 1024 * 1024 })`. It still hashes all bytes and retains the same before/after device, inode, size, mtime and ctime checks. No mtime-only cache, trust relaxation or stale fingerprint is used.

The memory trade-off is larger bounded read buffers: a stream can hold its 1MiB buffer plus an in-flight read. This is not an RSS measurement. If real native-check memory pressure appears at configured concurrency, measure peak RSS and evaluate a smaller chunk size while preserving complete hashing; do not replace content validation with metadata-only caching.

Truncating the candidate stream to its first MiB deliberately fails both collector tests through the independent expected SHA-256. The exact candidate source was restored byte-for-byte afterward.

### Registered process-group absence

Signal **0** queries only the registered child's process group and does not deliver a signal. `ESRCH` is kernel evidence that the group has no member. A present group still uses the prior zombie-aware process census. Permission/other query errors propagate; they are not closure evidence. Initial registered PID identity validation and identity-checked destructive stopping remain unchanged.

A real child held by stdin proves that a live group is not empty; closing its owned stdin and observing actual child close proves the absent case. A denied existence query is rejected. Deliberately treating a successful presence query as empty fails the live-group regression. These claims cover the registered process group, not escaped descendants or remote effects.

## Evidence

The local archive is `/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-m3-revision-entry.liXjHv`. Full logs/reports also remain under `/tmp/scry-workflow-template-editor.ZnkC6L/`. Local checksums are integrity evidence, not signatures or external execution receipts.

- Cold component: `m3-cold-governing-{baseline,candidate}.{json,log}`, `m3-cold-governing-{red,correctness,validation,negative}.log`.
- Stream component: `m3-check-stream-{baseline,candidate}.{json,log}`, `m3-check-stream-negative.log`.
- Scope component: `m3-check-scope-baseline-valid.{json,log}`, `m3-check-scope-candidate.{json,log}`, `m3-check-scope-{red,negative,correctness}.log`.
- The first scope collector failed metadata validation because `subprocess` is not a supported layer; it was corrected to the existing `main` layer before baseline publication. The failed log remains `m3-check-scope-baseline.log`.
- Full current-source unit: `m3-revision-entry-store-scope-full.log`: **344 files / 4007 tests passed**, four opt-in files/tests skipped. Node/web types, production build, production revision input/IPC and actual App-process restart also passed; see [revision entry status](../../designs/scry-workflows/revision-entry-status.md).
- Official mapped scenario: `m3-revision-entry-performance.log`: **No counter collector matches providers.catalog**.

## Timing and limitations

Several earlier current-source tests timed out at their unchanged **5000ms** limit. The initial 600s full-suite tool deadline also interrupted coverage; a later complete run had one original native positive timeout. Those failures remain evidence, not replaced by a later passing run.

After the first stream change, a focused run at load 20.1→29.83 on 10 cores still timed out in both native-controller cases and an original loop-controller case. After the group-absence change, a four-file run at load 8.53→8.14 passed 28 tests, including native positive/negative cases at 3609/3256ms and the original seven process tests. The later full unit run passed native positive/negative at 4054/3370ms and the unchanged three-revision/eleven-call map at 3895ms.

The full run's overall load was 4.46→16.89 (`highLoad=true`). Load and several implementation changes differ between these runs. **No causal millisecond improvement, stable p50/p95, arbitrary-load stability, App/L2 speedup or daily-use/L3 result is established.** The supported improvement is L1: fewer actual publications, delivered hash chunks and process-list subprocesses, with required bytes, root publications and authority checks retained. The removed work was eliminated, not deferred to a background path.
