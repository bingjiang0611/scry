# Isolated Workflow checkpoint experiment

**Experimental Node 24.18.0 / macOS prototype only. Not the App backend. Do not run it against real userData, migrate data, or wire these resolver aliases into production.** No new dependency is installed. `node:sqlite` is not evidence for the Electron/better-sqlite3 distribution.

History: [initial evaluation](../../docs/performance-experiments/20261029-workflow-sqlite-checkpoint.md). The authorized [dual-backend follow-up](../../docs/performance-experiments/20261029-workflow-checkpoint-contracts.md) resolves the 13 old physical-path failures and exposes/fixes a real pre-COMMIT value-cache bug. SQL functional checks pass 93 tests, with IO meter's 3 tests run separately. File first passed 58, then had 2 unchanged 5000ms process-recovery timeouts under high load. Stable full equivalence and production rollout are **not approved**.

## Prepare once, in a new temporary directory

Run from the repository root with the installed project dependencies:

```sh
node --version # verified: v24.18.0
trial=$(mktemp -d /tmp/scry-checkpoint-eval.XXXXXX)
node experiments/workflow-checkpoint/prepare.mjs "$trial"
export SCRY_CHECKPOINT_BUILD="$trial/build"
```

Generation keeps all business methods and validators from the current `src/main/workflow-store.ts`. It replaces metadata read/write/lock/enumeration primitives, not the Scheduler/Runner. The manifest records the original/generated Store and compiled Worker hashes. A second preparation needs a fresh directory; do not overwrite earlier evidence.

The generated Store is resolved only by the experimental Vite/esbuild adapters. Immutable artifacts remain files. WAL metadata uses FULL/fullfsync; an artifact directory barrier completes before committing its SQL reference. Native facts and later terminal frames remain separate commits.

## Fixed five-case comparison

Run the two variants **serially**, through the existing timing lock:

```sh
filter='reuses unchanged iterations|matches stable map keys|runs fresh replica|invalidates a consumer|retains a legacy first SystemStep'
for variant in baseline sqlite; do
  SCRY_CHECKPOINT_RESULT="$trial/$variant.json" \
    node .agents/skills/scry-performance-climb/scripts/timing-run.mjs "checkpoint-$variant" -- \
    npm run test:unit -- --config "experiments/workflow-checkpoint/vitest.$variant.config.ts" \
    src/main/workflow-dynamic-loop-revisions.test.ts \
    src/main/workflow-dynamic-revisions.test.ts \
    src/main/workflow-system-revision.test.ts -t "$filter" \
    > "$trial/$variant.log" 2>&1
  printf '%s exit=%s\n' "$variant" "$?"
done
```

The baseline may fail the unchanged 5000ms deadline. Preserve that exit status and JSON; do not add retry, sleep, a longer timeout, or smaller inputs. A `highLoad:true` sample is not trustworthy latency evidence. CLI wall includes hooks/closure, but not the explicit prepare/build command above.

`CHECKPOINT_METHODS` is inclusive method time, not a critical-path decomposition. `CHECKPOINT_JS_IO` scopes the listed in-process fsPromises/FileHandle operations to each Store, including the sibling initialization lock. `CHECKPOINT_SQLITE` exposes SQL counters, queue peaks, durability settings and **pre-close** DB/WAL sizes. SQL puts are counted when executed, not necessarily committed; COMMIT counts exclude rejected commits. OS/native SQLite IO, physical device bytes and total fsync remain unavailable. Never infer that work disappeared because it moved to SQLite/Worker.

## Fault and source contracts

```sh
SCRY_CHECKPOINT_RESULT="$trial/prototype.json" \
  node .agents/skills/scry-performance-climb/scripts/timing-run.mjs checkpoint-prototype -- \
  npm run test:unit -- --config experiments/workflow-checkpoint/vitest.sqlite.config.ts \
  experiments/workflow-checkpoint/prototype.test.ts \
  experiments/workflow-checkpoint/io-meter.test.ts
```

This checks actual local IO, COMMIT-before-ACK, transport loss after a real Worker exit, cold reads, queue closure, namespace containment, separate processes/connections and counter sensitivity. No paid Provider/Jev is used. The esbuild adapter also closes owned storage in the existing real controller fixture, so completion cannot leave a ref-counted Worker pinning that process.

## Shared File / SQL contracts

For IO-fault/source suites, use `vitest.contracts.config.ts`. It omits eager meters and lets each suite register its fs probes before Runtime loads. **Do not run `io-meter.test.ts` in this configuration:** its counters require the standard experimental config above.

The same 58 semantic cases run on both backends. File's physical flush/rename/sync assertions remain in `src/main/workflow-storage-probe.fixture.ts`; the SQL test driver uses an independent canonical database reader, actual held COMMIT and real deferred-constraint COMMIT rejection. The latter is not a device/ENOSPC fault. Semantic-corruption input updates SQL bytes and their envelope hash deliberately; independent hash-corruption negative controls still test that separate boundary. The held sequence test inspects canonical storage independently rather than waiting on the writer's deliberately serialized read queue.

```bash
contracts=(
  src/main/workflow-frame-store.test.ts
  src/main/workflow-native-checkpoint.test.ts
  src/main/workflow-node-stop-journal.test.ts
  src/main/workflow-recovery-process.test.ts
  src/main/workflow-recovery.test.ts
  src/main/workflow-restart-contract.test.ts
  src/main/workflow-sequence-checkpoint.test.ts
  src/main/workflow-store-checkpoint.test.ts
  src/main/workflow-store-governing.test.ts
  src/main/workflow-store.test.ts
  src/main/workflow-system-recovery-process.test.ts
)
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs checkpoint-file-contracts -- \
  npm run test:unit -- "${contracts[@]}" --maxWorkers=1 --no-file-parallelism \
  --reporter=default --reporter=json --outputFile="$trial/file-contracts.json" \
  > "$trial/file-contracts.log" 2>&1
SCRY_CHECKPOINT_RESULT="$trial/sql-contracts.json" \
  node .agents/skills/scry-performance-climb/scripts/timing-run.mjs checkpoint-sql-contracts -- \
  npm run test:unit -- --config experiments/workflow-checkpoint/vitest.contracts.config.ts \
  "${contracts[@]}" --maxWorkers=1 --no-file-parallelism \
  > "$trial/sql-contracts.log" 2>&1
```

Preserve each exit status even when a preceding command fails. To reproduce the 93-case SQL batch, append the three revision files from the fixed comparison **without `-t`**, plus `experiments/workflow-checkpoint/prototype.test.ts`. Run the IO meter's three cases separately with `vitest.sqlite.config.ts`. Do not aggregate duplicate prototype runs as additional distinct coverage.

Typecheck and syntax checks:

```sh
npm run typecheck
node_modules/.bin/tsc --noEmit -p experiments/workflow-checkpoint/tsconfig.json
node --check experiments/workflow-checkpoint/prepare.mjs
node --check experiments/workflow-checkpoint/negative-control.mjs
npm run test:unit -- scripts/performance-ratchet.test.ts
```

The default project test config still excludes `experiments/`; these experimental configs are explicit opt-ins, not a new production gate.

## Deliberately broken negative controls

Only derived files under the prepared build are changed. Modes are finite: `metadata-hash` (default), `result-hash`, `early-ack`, `frame-cas`, `epoch`, `value-cache`. Every manifest marks the derivative as ineligible for adoption.

```sh
node experiments/workflow-checkpoint/negative-control.mjs \
  "$trial/build" "$trial/build/negative-result-hash" result-hash
SCRY_CHECKPOINT_BUILD="$trial/build/negative-result-hash" \
SCRY_CHECKPOINT_RESULT="$trial/negative-result-hash.json" \
  node .agents/skills/scry-performance-climb/scripts/timing-run.mjs checkpoint-negative-result-hash -- \
  npm run test:unit -- --config experiments/workflow-checkpoint/vitest.sqlite.config.ts \
  src/main/workflow-frame-store.test.ts -t 'verifies immutable content and workflow containment'
```

Expected: **one assertion failure**, not just an arbitrary nonzero exit. A preparation/import error or zero collected tests is not a valid negative control. Other selectors and actual outcomes are recorded in the follow-up report and archived logs. `epoch` targets `workflow-recovery.test.ts -t 'reuses a durable completed child'`; `value-cache` targets `prototype.test.ts -t 'rolls back a real SQLite COMMIT'` and must fail both cases. A genuine merged-A/B rollback negative control is still missing; the strengthened positive boundary check does not replace it.

Keep logs/builds until their hashes are archived. Only clean up owned test resources. The prototype rejects existing legacy metadata and a missing marked database instead of creating an empty history. There is no migration, fallback, automatic retry, or production lifecycle integration.
