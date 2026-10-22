# A2 — catalog cache and exact no-op saves

## Hypothesis and fixed baseline

Repeated catalog reads reparse recent/project files. Exact duplicate session notifications write the same primary and backup again. Do not remove fsync, atomic rename or backup recovery, and do not change activity timestamp semantics.

Command: `npm run test:unit -- src/main/app-store-performance.test.ts`.

The collector wraps real filesystem functions and drives production stores in a temporary userData: remember project, pending notification twice, native identity twice, terminal result twice, then three catalog refreshes. It does not call a real Provider or import Electron main. It counts all `readFileSync`, `writeFileSync`, and `fsyncSync` calls inside this workload; stat and existence checks are not reads in this metric. Both clocks run unchanged before/after: same timestamp, and advancing timestamp for every notification.

| Clock | Baseline file reads | Atomic file writes | fsync calls |
|---|---:|---:|---:|
| same-ms | 6 | 14 | 28 |
| advancing-ms | 6 | 14 | 28 |

Baseline: macOS arm64, Node (see batch report), local controlled workload. L1 only; no latency claim and no machine-load inference from Vitest duration. First attempt could not find vitest because node_modules was incomplete; `npm ci` restored the locked dependencies, then both cases passed. No source or lockfile changes from installation.

Optimization results and commit identities will be recorded after implementation in this file and the batch report. Baseline collector must remain unchanged.

## Acceptance

- recent/project stores retain one read cache per production singleton, keyed by `dev:ino:size:mtimeMs`, never cache failed/degraded recovery, and return independent copies.
- Exact unchanged session content skips writes; different activity timestamps still persist. No semantic coalescing across a turn.
- External primary replacement/edit and fallback repair keep existing health semantics. Existing `.bak` and fsync behavior remains on actual writes.
- Tests check cache copies, external changes and real atomic-file identity on no-ops.
