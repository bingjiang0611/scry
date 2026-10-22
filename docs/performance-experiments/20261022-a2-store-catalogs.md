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

Baseline measurement commit: `f45a679`. The collector is unchanged by optimization; commit identities are also listed in the batch report.

## Result

| Clock | Optimized reads | Atomic file writes | fsync calls | Interpretation |
|---|---:|---:|---:|---|
| same-ms | 2 | 8 | 16 | Four repeated recent/project reads removed; three exact duplicate notifications no longer replace primary/backup. |
| advancing-ms | 2 | 14 | 28 | Read savings remain; distinct activity times still require every durable write. |

Both are L1 controlled results, not App latency or real-Provider measurements. The removed reads are replaced by metadata validation plus cloning from one cached primary per store. Actual writes retain the original atomic rename, file/directory fsync, and backup copy behavior. No work is deferred past turn completion.

Production recent/project factories are now lazy singletons in `src/main/index.ts`. Session saves compare normalized current content, including timestamp, before writing. This deliberately does **not** coalesce notifications with different timestamps: changing their activity ordering would require a separate product decision. Missing/degraded session primaries bypass the no-op guard and are repaired; backup recovery is not cached, so external backup edits remain observable.

Validation: `npm run test:unit -- src/main/app-store.test.ts src/main/app-store-cache.test.ts src/main/app-store-performance.test.ts` passed 33 tests; `npm run typecheck` passed. Negative control: the three new cache/no-op tests all fail against baseline `f45a679` (two extra read failures, one inode-replacement failure) in an isolated worktree. Full suite/UI/performance results belong to the batch report.

## Acceptance

- recent/project stores retain one read cache per production singleton, keyed by `dev:ino:size:mtimeMs`, never cache failed/degraded recovery, and return independent copies.
- Exact unchanged session content skips writes; different activity timestamps still persist. No semantic coalescing across a turn.
- External primary replacement/edit and fallback repair keep existing health semantics. Existing `.bak` and fsync behavior remains on actual writes.
- Tests check cache copies, external changes and real atomic-file identity on no-ops.
