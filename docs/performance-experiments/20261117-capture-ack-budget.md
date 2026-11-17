# Capture ACK deadline and interrupted initialization

## Frozen baseline (before the candidate)

- Source baseline: `1fc36f069d92975453f8f27e99aa0ba201aec726` (recorder 0.2.76).
- Real-host failure: remote CodeLens CI `90857169`, commit `311a153020410d32aaf37202f3e88469b2365b59`, bundled recorder 0.2.75, Qoder CLI 1.1.89, Friday 0.7.62 (`0d978057a92a76d7b194d37f01ad40f6ea1fb7e9`). `LC_ALL=zh_CN.UTF-8` overrides `LC_TIME=C`; workspace and script paths contain Chinese characters.
- Native session `7846800f-752f-49aa-a4bd-1dd49878893a` correctly matched request `26759544-acab-4ed9-9742-fd8d7ed9aec5`. PostToolUse and Stop both returned `recorder_timeout` / outcome unknown. An open turn and generation were persisted, but no capture control/receiver, active CodeLens state, or upload receipt existed at inspection. Do not replay this session to manufacture completion.
- Separate offline protocol fixture: one committed Git file, one fixture Qoder transcript, a fresh workspace per sample, no real host events, daemon or commit/upload callback. Full CLI start ACK: **2072, 2094, 2145 ms**, all complete `started` ACKs and exit 0. Three samples are diagnostic, not a P95/SLA. The caller's gate phase was capped at **1500 ms**.
- IO-profiled fixture: 1934, 1958, 1956 ms wall; 1001–1066 ms inside the Node preload, including 64–74 ms across 14 fsync calls. Profiling preserves `execFile`'s custom promisifier. Initial invalid-envelope and broken-profiler runs are excluded, not counted as successful samples.
- Import-only probe loaded the command graph in about 70 ms. This does not justify a broad lazy-import refactor as the timeout fix. Process wall time outside the instrumented JavaScript is not yet attributed to a specific OS component.
- macOS, Node 24.18.0, 10 logical cores; timing wrapper reported load above the core count. No speedup or baseline equivalence is claimed from these small, loaded samples.
- Raw evidence and fixture programs: `/tmp/codelens-locale-real-90857169/` (`verification-native.json`, `capture-ack-baseline-076-cli-valid.json`, `capture-ack-io-profile-valid.json`). These are local test artifacts, not committed transcripts or release evidence.

## Candidate and acceptance

1. Keep start synchronous: transcript boundary, host evidence, diff baseline and durable state must precede a successful ACK. Do not move baseline capture after ACK or remove fsyncs for timing.
2. Refuse adoption of a partially initialized capture turn. A persisted open file alone is not completion evidence; legitimate empty/no-Git baselines must remain distinguishable from interruption. A completed baseline must be reused on retry, without changing generation or the turn boundary.
3. Allocate the existing CodeLens event budget to allow a roughly two-second recorder start, while preserving the native host's five-second limit and the bounded receiver forward. Prove the slow-but-successful start with a failing control, and retain slow/failing receiver tests.
4. Keep macOS recorder host identity independent of date locale. Its ps table contains only pid, ppid and start time, not argv.
5. Run focused regressions first, then related recorder/CLI/CodeLens suites. Use exact remote-CI artifacts for subsequent native acceptance. Local builds and synthetic protocol fixtures are development evidence only; no package publication or merge is authorized by this experiment.

A repository baseline or a recorder that still exceeds the bounded event budget remains unknown/failed, never a fabricated successful start. If reallocating the existing budget is insufficient, measure the remaining critical path before considering a different initialization protocol.

## Results

- The candidate uses a durable `initialization: pending/complete` marker for capture turns only. Ordinary Hook write counts remain unchanged. Both first and repeated starts reject incomplete opens. Legacy empty continuation baselines cannot prove completion and remain unavailable; they are not silently reconstructed.
- Session state and open inspection now share the existing session lock. Repeated starts repair context publication without reopening a generation. Exclusions union only within the same capture; the session-level union is persisted before updating open/context, so it survives removal of the open turn.
- macOS ps now uses a child-only C locale. A present pid with an old localized date token is unknown, not evidence of pid reuse. The Chinese-locale native macOS process probe returned a three-entry chain and `running`.
- `npm run typecheck` passed. The complete `check:cli-runtime` test selection passed **107 files / 1197 tests** with `--maxWorkers=1`, matching CI's one-worker-per-shard policy. `npm run build:cli` and `npm run smoke:cli-package` passed (bin, idempotent init, recorded Hook, healthy doctor, isolated concurrent notifications, preserved legacy cursor).
- Failure history is retained: the first broad check hit its 240-second outer command limit; a subsequent two-worker run exposed extra ordinary-Hook writes introduced by the initial candidate (fixed, not waived), plus managed-tool Hook five-second test timeouts. The final run used unchanged test timeouts and assertions. Focused managed-tool tests also passed 17/17. These runs do not establish a performance speedup.
- Regression controls failed before the corresponding fixes: incomplete and legacy initialization, context publication, concurrent start, later-turn interruption, exclusion publication/capture isolation, localized ps identity and legacy-token expiry. The real-Git fixture verifies preservation of the original baseline/turn identity and tracked plus post-ACK untracked edits after an interrupted publication.
- CodeLens candidate: phase allocation 1.5 → 2.5 seconds; the 3.5-second budget constant and one-second forward cap are unchanged. Interpreter startup and cleanup are outside those component caps, so native wall time still needs acceptance. The slow-start fixture initially both timed out and passed under different observations; its final uninstrumented focused run and full suite passed. No timing threshold was loosened.
- CodeLens ran 100 opt-in tests: 99 passed, while the existing inactive-input performance test failed its six 50 ms subcases. Restoring all Hook source bytes to commit `311a153020410d32aaf37202f3e88469b2365b59` (`git diff --exit-code HEAD -- .claude/hooks`) reproduced all six failures on the same machine. This does not make the performance check pass. Fifteen other required/focused smoke scripts passed.
- Logs: `recorder-cli-final-single-worker.log`, `recorder-cli-candidate-full.log`, `codelens-budget-full.log`, `codelens-budget-inactive-baseline.log`, and `codelens-budget-smokes/results.json` under the evidence root above.

Exact remote-CI artifacts and native Qoder/Friday capture + automatic upload acceptance are still pending. The development build/package smoke is not a published-package or end-to-end result.
