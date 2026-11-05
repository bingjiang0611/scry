# Recorder engine L1 baseline (2026-11-05)

Produced by `scripts/recorder-engine-bench.mjs` on branch `perf/recorder-engine` at commit
`75ac7190`-equivalent state (pre-G1 code, CLI 0.2.59 core), together with
`scripts/recorder-engine.measurement.test.ts`.

- Machine: macOS (darwin) Apple silicon, Node v24.18.0, git 2.50.1 (Apple Git-155).
- Library load average during the run: see `environment.loadavg` in the JSON.
- Hooks are driven **in-process** through `handleRecorderHook` (the direct write path), not through
  a Provider or the daemon. Provider latency is therefore not part of any number here.
- `git=N` is a real subprocess count from a counting `git` wrapper placed first on `PATH`; the
  wrapper only appends its argv and execs the real binary.
- `idx≈` is the full-index-per-rewrite estimate (index size at the start of each index-rewriting
  command), not bytes written inside Git.
- `parse=`/`anchor=` are the recorder's own process-local counters for transcript reads.
- `rss+` is the peak RSS growth inside that stage, not the process peak.

Run: `npm run build:cli && SCRY_BENCH_INDEX_BYTES=1 node scripts/recorder-engine-bench.mjs --out=…`

| Scenario | start git | end git | other |
|---|---|---|---|
| S1 small repo, 1 file | 4 | 9 | idx≈24 KB |
| S2 20k tracked, 1 file | 4 | 9 | idx≈4.8 MB |
| S3 20k tracked, dirty baseline | 9 | 9 | begin idx≈6.4 MB |
| S4 20k tracked, 300 files | 4 | 11 | diff:5 (numstat+name-status+3 patch batches) |
| S5 one 50 MB file | 4 | 9 | end 15.1–17.6 s, peak RSS +1.74 GB |
| S6 18 repositories, 3 changed | 36 | 72 | config:18 at end |
| S7 30 tool calls (60 events) | 4 | 3 | tool stage: 0 git |
| S8 50 MB transcript | 9 | 6 | parse 52.4 MB + anchor 52.4 MB, end ≈1.0–1.2 s |
| S9 commit, 0/1k/10k history | — | — | 22 / 28 / 41 ms per commit |
| S10 4 sessions × 5 turns | 140 per round | | 4.9–5.9 s per round |
| S11 recovery, 1000 session dirs | 4 | — | 221–254 ms |

Complementary filesystem counters (`scripts/recorder-engine.measurement.test.ts`):

| Measurement | Result |
|---|---|
| One turn (start + 2 tool events + stop) | 40 fsyncs, 24 `readdir`, 51 `readFile` |
| Commit with 0 / 200 / 1000 records | lock held 22.4 / 28.0 / 29.3 ms; 2 / 1 / 1 `readdir` inside the lock |
| Recovery with 0 / 200 / 1000 finished session dirs | 15 / 1015 / 5015 `readdir`, 12 / 412 / 2012 `readFile`, 25 / 52 / 175 ms |
| 20 identical patches in one turn | 20 hashes, 19 read-backs, 19 directory syncs (20/20/20 when already stored) |

## Largest costs seen, in priority order

1. **S5: one 50 MB text file change**, end phase 15–18 s and +1.7 GB peak RSS. Git's line diff on a
   single 50 MB line dominates the wall time; the in-memory patch (≈100 MB) is then copied through
   the record serialization several times.
2. **S6: 18 repositories**, 108 Git processes per turn, of which 18 `rev-parse` (layout) and 18
   `config` (filter rescan) are re-derived every turn.
3. **S8: 50 MB transcript**, every turn re-reads and re-anchors the whole file (≈105 MB of reads).
4. **S3/S2: 20k tracked files**, `read-tree` + `add -A` runs twice per turn (begin snapshot and
   targeted after-tree), each rewriting a ≈4.8–6.4 MB index.
5. **S11: recovery**, `readdir`/`readFile` grow linearly with finished session directories.
