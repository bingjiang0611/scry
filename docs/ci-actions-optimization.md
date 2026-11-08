# Actions duration investigation

## Baseline and measurement

The initial `gh run list --limit 50` snapshot contains 50 runs and 265 jobs.
Raw run/job responses, cache metadata and the per-job CSV are retained locally
as `/tmp/scry-actions-before-{runs,jobs,phases}.json` (CSV: `before-phases.csv`),
not uploaded: workflow logs may contain diagnostic data.

Phases use GitHub timestamps, not estimates of CPU time:

- Queue: job `created_at` → `started_at`. Dependency waiting before job creation
  is visible in total workflow elapsed time, not counted as runner queue time.
- Preparation: runner start → first validation/build step.
- Execution: first validation/build step → job completion. This includes report
  upload and cleanup; GitHub does not expose pure test-subprocess time.
- Skipped jobs have no meaningful execution duration. Cancelled/failed runs stay
  in the raw data but are not used for successful-job medians.

| Successful job | Samples | Queue (s), median | Preparation (s), median | Execution (s), median |
| --- | ---: | ---: | ---: | ---: |
| CI node | 11 | 3 | 22 | 39 |
| CI unit 1 / 2 / 3 / 4 | 11 each | 3 | 26 / 24 / 25 / 25 | 132 / 143 / 149 / 192 |
| CI renderer 1 | 6 | 3 | 36 | 330 |
| CI renderer 2 | 8 | 3 | 33.5 | 456 |
| CI CLI Node 20 / 22 / 24 | 11 each | 3 | 18 / 16 / 19 | 109 / 108 / 109 |
| CI Linux package | 7 | 3 | 24 | 78 |
| Performance compare | 7 | 3 | 24 | 70 |
| Performance native | 7 | 3 | 72 | 117 |

Successful CI workflow elapsed time: median 486.5 seconds, 4 runs. The sample is
small; failures and cancellations must not be presented as successful speedups.
The renderer second shard's actual smoke step has a 450.5-second median.
No remote compilation ran in this 50-run sample; transport/iOS cache benefits
cannot be inferred from these runs.

Caches: 45 entries, 8.77 GiB total (Linux npm ~4,350 MiB, macOS npm ~3,335 MiB,
iOS package sources ~582 MiB, Swift builds ~715 MiB). Root installations already
use setup-node's npm cache. Do not add node_modules, desktop output or unrelated
language caches to this nearly full repository cache.

Two consecutive local production builds on the unchanged source took 6.041 s
and 4.636 s, both exit 0. The second build is not incremental: electron-vite
intentionally rebuilds. CI's production smoke block invokes this build four
times on the same source; sharing one fresh build removes redundant work without
adding a persistent artifact cache or trusting stale output.

## Controlled remote comparison

A documentation-only baseline commit will first run the original workflows on
the task PR. Optimization commits then change workflow/test orchestration only;
application code and test assertions remain unchanged. Record exact revisions,
run IDs, failures and the final comparison here after the remote experiments.
