# Fixed before/after performance evidence

This is a standalone Vitest fixture. It is intentionally outside the default Vitest suite and imports the measured source dynamically.

```sh
# Baseline checkout: source defaults to that checkout's src/
npx vitest run --config experiments/performance-evidence/vitest.config.mjs

# Candidate checkout/source tree (absolute path, read-only)
SCRY_B_SOURCE=/absolute/path/to/candidate/src \
  npx vitest run --config experiments/performance-evidence/vitest.config.mjs
```

The harness does not build, install, invoke a Provider, or mutate the source tree. `SCRY_B_SOURCE` may also name a repository root; `src/` is selected when needed. Each stdout line is one JSON operation. `SCRY_BENCH_OUT=/absolute/path/out.jsonl` additionally appends those lines to an aggregation file. The output includes source SHA/path and the source environment value.

Default workload is Git 4/100/1000 changed files, Pi 4000 turns, and three real commit repetitions. Use `SCRY_BENCH_SMALL=1` for the explicitly reduced debugging workload (Git 4, Pi 40, one repetition); it is labelled `scope: "small"` and is not final evidence. `SCRY_BENCH_REPEATS` is capped at three.

Git measures only `finishGitTurnDiff(capture, 10_000)` after setup. The production default patch budget remains in force. It reports status, file count, every Git child-process invocation, and patch-spawn count. A timeout or unavailable result is reported as such; it is never converted to a complete 1000-file result.

Pi uses the production `readPiNativeHistory` plus `sessionHistoryPage` on baseline source. A source exporting `readPiNativeHistorySnapshot` is measured through metadata, latest/older pages, and `hydrate(runIds)`. Cold, unchanged warm, one append, and second warm phases report physical FileHandle bytes and scoped `JSON.parse` calls. Selected payload IDs and a SHA-256 of IDs/text/tools allow baseline/candidate parity checks without dumping transcript text.

The managed case calls the real recorder hook, evidence aggregation, and managed commit with a fixed 256 KiB user prompt. A transparent FileHandle proxy counts actual `writeFile` bytes in only `managed-turn-commits/` and `managed-turn-journal-state/`; canonical record persistence is checked from disk. No expected-byte or fake counter is used.

The fixture is an observer-only measurement commit. Do not run it against real Provider/account data. Parent aggregation should run baseline and candidate serially under the timing lock on the designated Mac.
