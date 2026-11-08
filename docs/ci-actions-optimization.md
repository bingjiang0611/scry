# Actions duration investigation

## Baseline and measurement

The initial `gh run list --limit 50` snapshot contains 50 runs and 265 jobs.
Raw run/job responses, cache metadata and the per-job CSV are retained locally
as `/tmp/scry-actions-before-runs.json`, `/tmp/scry-actions-before-jobs.json`
and `/tmp/scry-actions-before-phases.csv`,
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

PR [#41](https://github.com/bingjiang0611/scry/pull/41) first ran the original
workflows on documentation-only revision `9614b873` (base `c77aab61`). Its
[CI run 42463040787](https://github.com/bingjiang0611/scry/actions/runs/42463040787)
failed in the existing Pi command fixture: `Missing Pi command control:
#pi-command .question-other`. Its successful second UI shard took 373 seconds,
but the failed whole run is **not** a successful performance baseline. This
fixture failure is not hidden, retried or weakened by the optimization.

First optimization revision `c6c720f8` passed CI, Performance and Remote checks.
[CI run 42463591965](https://github.com/bingjiang0611/scry/actions/runs/42463591965)
took 384 seconds (about 21% below the successful historical median, one sample).
The three macOS jobs took 364 / 264 / 232 seconds. The first shard's last five
smokes took about 50 seconds; moving that contiguous tail to shard 2 balances
the critical path without changing scenario order or assertions.

[Remote run 42463591845](https://github.com/bingjiang0611/scry/actions/runs/42463591845)
passed. iOS waited about 231 seconds for a macOS slot, then spent 473 seconds in
the job. The two Xcode build steps took 216 and 232 seconds. Both projects depend
on the same local ScryG0Transport package with identical resolved dependencies,
yet separate DerivedData paths rebuilt those dependencies twice. The next
optimization shares job-local DerivedData and one package-source cache; both
original Xcode actions, simulator target, architecture and signing flags remain.
Compiled Xcode output is not uploaded to the repository cache.

## Scope and safeguards

- PR supersession cancellation stays enabled in CI/Remote and is made PR-only
  in Performance. Non-PR Performance dispatches use a unique run ID; main CI and
  Remote retain SHA-specific groups with cancellation disabled.
- Required workflows are not filtered by `paths-ignore`: GitHub would leave their
  required contexts pending. A shared, fail-closed Git diff skips heavy jobs only
  for README.md/docs/**/*.md and still emits all three required summaries. Code,
  configuration, Agent instructions and mixed diffs are not excluded.
- All 29 ordered top-level renderer smoke invocations remain, including their
  nested scenarios and negative controls. No assertions, deadlines, coverage
  thresholds, Node versions, platform gates or performance budgets are removed.
- The production smoke block builds once, then uses explicit prebuilt commands.
  Standalone smoke commands still build first. This avoids three builds rather
  than pretending a mandatory fresh production build is a no-op.
- Full desktop typechecking runs in the Node gate, not three more times in the
  compatibility matrix. Every Node 20/22/24 lane still compiles both CLI outputs,
  runs its full former runtime selection, and installs/tests a clean tarball.
- A third, clean-install experiment ran every build-only Node job command after
  `npm ci --ignore-scripts`, with no electron/path.txt or Electron executable:
  typecheck, harness binding checks (including missing-binding controls), shell
  tests, desktop build and both CLI builds all passed. That job now omits the
  unused Electron download/sandbox preparation; runtime jobs retain it.
- Linux packaging drops only the earlier duplicate native preparation. The
  authoritative forced Electron ABI rebuild and actual SQLite/node-pty load
  probe in run-electron-builder remain unchanged.
- npm setup caches were already enabled. No node_modules/output caches or new
  Go/Rust caches are added. The existing workflows have no go/cargo source tool
  installs to replace. The local actionlint check uses prebuilt version 1.7.12.
- Three renderer shards plus native performance use four macOS slots normally.
  Remote changes add two jobs, so one may queue at the five-slot cap; unrelated
  PRs/workflows can increase waiting. No runner concurrency quota is bypassed.

Second-round revision `b9379cf2` passed
[Remote run 42464864565](https://github.com/bingjiang0611/scry/actions/runs/42464864565).
The iOS job fell from 473 to 287 seconds (39.3%); its second compile fell from
232 to 113 seconds (51.3%). These are single hosted samples, not a stable latency
claim. Scheduling also improved between runs; queue savings are not attributed
to compilation reuse.

The same revision's CI/Performance/PR Vouch runs encountered GitHub HTTP 504s.
CI and native performance failed while downloading the official Electron zip,
before affected tests ran. The failures remain failures, not faster passes.
Direct endpoint probes also returned 504; GitHub's status page did not declare an
incident. No retries, mirrors, alternate binaries or relaxed checks were added.

Supersession was exercised on `68c7a7af` → `b9379cf2`: all three older validation
workflows were automatically cancelled. The documentation-only
[probe PR #42](https://github.com/bingjiang0611/scry/pull/42), based on the optimized
branch, produced successful Check/Performance Check/Remote Check and skipped all
heavy jobs (runs 42465093982 / 42465094099 / 42465093951). It was closed and its
remote/local temporary branch cleaned up after verification. No main branch or
ruleset settings were changed for these experiments.

The final run IDs, timing comparison and remote verification limits are recorded
in the PR description after the second experiment. Historical/controlled workloads
and host load differ; one hosted run is not proof of a stable latency distribution.
