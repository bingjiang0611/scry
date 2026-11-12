# Workspace listing: reuse one locale-aware collator

## Trigger and scope

PR #63's `290ec6d5` run [43230347578](https://github.com/bingjiang0611/scry/actions/runs/43230347578) failed the unchanged `workspace.files/batchMeanP95Ms` budget: baseline 25.021ms, candidate 40.286ms, ceiling 37.531ms. The same-source control measured 27.102ms versus 40.023ms. Neither result proves that this PR caused a regression; `workspace-files.ts` was unchanged then. The maintainer authorized investigating and minimally fixing this path without relaxing budgets, reducing samples, or rerunning assertions to obtain green.

The observed production waste is independent of that attribution: `listWorkspace` supplied locale/options to `String.localeCompare` for every name comparison. ECMA-402 specifies collation initialization for that request. The fixed 122-entry workload makes 543 such requests on this machine.

## Alternatives considered

| View | Option | Decision |
| --- | --- | --- |
| Reuse | One `Intl.Collator` per list request | Selected: standard platform API, identical locale/options |
| Allocation | Avoid per-comparison options and collation setup | Included in the selected change |
| Algorithm | Replace locale sorting with lexical/numeric custom code | Reject: changes ordering semantics |
| Lifetime | Cache a collator globally | Not needed; per-request reuse removes the repeated work |
| IO | Reuse canonical roots across child path checks | Out of scope: needs separate security/race evidence |
| Concurrency | Change filesystem request fan-out | No evidence that this is the cause; leave unchanged |
| Memory | Cache whole directory listings | Reject: invalidation and stale authority add unrelated behavior |
| Paging | Sort only a page or shrink the listing | Reject: changes the snapshot/pagination contract |
| Measurement | Increase budget, discard outliers or reduce samples | Reject: retains all existing gates and 20 samples |
| Adjacent paths | Change remote directory pickers too | Out of scope; no demonstrated need in this failure |

## Measurement before implementation

Commit `93378f04` (rebased as `dd42cc0e`) adds only measurement/test helpers and a counter collector. It extracts the existing workspace fixture population and complete workspace workload so the collector uses the same 122 entries, 1MiB whole-file read/write, 64KiB page and original correctness oracles. It does not execute unrelated 500-session/120-archive setup in a new counter's hook. No timeout was increased after that initial hook exceeded 10s.

The collector counts both optioned `String.localeCompare` requests and explicit `Intl.Collator` construction. It also counts comparisons through either API; switching spellings cannot hide comparison work. A real extra collator increments setup work by exactly one without changing comparisons. These observations are diagnostic, not a new ratchet gate or a relaxed existing gate.

## Implementation and L1

`listWorkspace` creates one `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })` for the request and uses its comparator. Directory precedence, every path/symlink/stat check, sorting, snapshot hash and cursor validation remain intact. No work moves to another thread or outside the request. The removed work is 542 repeated collation setup requests, not the comparisons themselves.

| Observation | Before, five repeats | After, five repeats |
| --- | --- | --- |
| Collation setup requests | 543 / 543 / 543 / 543 / 543 | 1 / 1 / 1 / 1 / 1 |
| Name comparisons | 543 / 543 / 543 / 543 / 543 | 543 / 543 / 543 / 543 / 543 |
| Directory/file/page workload | 122 / 1MiB / 64KiB | Unchanged |

The fixture and full production-workload contracts passed on the old implementation before this change. Node22.22.1 workspace/counter/ratchet tests pass (38 tests); the independent default-locale/numeric/base-character ordering and pagination oracle fails when numeric collation is deliberately disabled, then passes after restoring the fix. Node/Web typechecks and App build pass. The experiment's implementation commit is the commit introducing this document.

## L2, identity and limits

One locked formal A1/B1…A20/B20 run retained all scenarios, iterations, warmups and samples. The baseline was clean measurement commit `93378f04`; the candidate was its working tree with the collator patch, not a second clean commit despite the harness recording HEAD for both. Both harness hashes were `a3e02bb594e10973060abf9209f048d5e379f6f808490c7101fa4731a577a73a`.

It measured workspace P95 30.509ms → 31.268ms and median 20.687ms → 18.894ms, but `SCRY_TIMING_RUN.highLoad` was **true** (10 cores; load 17.27 → 10.47). This is **not evidence of stable millisecond improvement**. The local aggregate also failed the unchanged archive-byte ceiling on both sides (10577 versus 10555), separate from this sorting path. Do not substitute this diagnostic for a green latest-head CI gate. No second timing run was used to select better numbers.

Raw local evidence is retained in `/tmp/scry-pr63-collation-{before,after}-counts.json`, `/tmp/scry-pr63-collation-abab-dir.txt`, `/tmp/scry-pr63-collation-abab.log` and the ordering negative-control/test logs. Final Linux L2 and acceptance are the PR's latest-head complete CI/Performance evidence, not this high-load local run.

## Linux L2 follow-up

PR head `e415c4a7` completed formal Node comparison in run [43242847350](https://github.com/bingjiang0611/scry/actions/runs/43242847350). Report identity: baseline `73c1cd992c222007b2c9e96e9314ac31fe9dc069`, candidate CI merge `35315f629759384951b69cd9cdb056a299d28250` (not the PR head), unchanged harness `a3e02bb594e10973060abf9209f048d5e379f6f808490c7101fa4731a577a73a`. Environment: Node22.23.4, Linux x64, four allocated cores; the timing lock recorded `highLoad: false`, load 2.17 → 1.99.

All 20 samples and original workload/oracles remained in use. `workspace.files.batchMeanP95Ms` was 72.986 → 57.351ms (-21.4%), ceiling 109.479ms; entry/whole-file/page counters remained 122 / 1048576 / 65539. The Node report passed. This supplies Linux L2 evidence for that artifact and run, not a promise for every machine. Raw report: `/tmp/scry-pr63-node-e415.55fI3m/report.md.json`.

The overall Performance run still failed Native assertions (including baseline failures), with all 12 Native timing locks marked high-load. Do not turn the Node result into a claim that the full gate passed. Follow-up Markdown context work and its limits are recorded in [the separate experiment](20261112-markdown-context-identity.md); every new PR head still requires its own full acceptance.

## Delivery

L1 and the above Linux L2 point are verified. At this record update the PR is not merged; current gate/merge state is authoritative at [PR #63](https://github.com/bingjiang0611/scry/pull/63). The daily App was not installed or changed, so L3 field-use improvement is unverified. No ledger ceiling, timeout, workload, sample count or runner version is changed by this experiment.
