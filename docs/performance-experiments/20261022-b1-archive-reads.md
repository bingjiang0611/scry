# 20261022 B1：轮次提交时的归档读取

- 路径：轮次结束 → `commitManagedTraceTurn`（managed / recorder disabled）与非 managed `recoverTraceTurnProgress`。
- 来源：`docs/handoff/perf-2026-10-22/review.md` #4，静态审查，未测量。
- 基线源码：`facca08`（批次 A 之后，B1 改动之前）。

## L1 采集器

`src/main/managed-turn-archive-reads.measurement.test.ts` 在 fs 边界包装 `readFileSync`、`lstatSync`、`fs/promises.readFile`，只统计两个路径：legacy 整份归档（500 轮，167,740 bytes）和本轮精确 per-turn 文件。统计不依赖实现中的 helper 名称，所以基线和候选用同一套计数。

```bash
npx vitest run src/main/managed-turn-archive-reads.measurement.test.ts
```

### 基线（`facca08`）

| 场景 | legacy 读次数 | legacy 读字节 | 同步读 | 同步 lstat |
|---|---|---|---|---|
| managed，轮中已有 progress（capture summary） | 2 | 335,480 | 2 | 2 |
| managed，轮中已有 progress（capture full） | 1 | 167,740 | 1 | 1 |
| managed，无 progress | 2 | 335,480 | 2 | 2 |
| recorder disabled | 2 | 335,480 | 2 | 2 |
| 非 managed progress 恢复 | 1 | 167,740 | 1 | 1 |

精确 per-turn 文件在这些场景里尚不存在（首次提交），所以读次数为 0；`upsertTraceArchiveTurnAsync` 内的异步检查不在本项范围内。

两次读取的来源：

1. `protectManagedInput`（锁外）在 journal/progress 都没有 `toolContentPolicy` 时调用 `matchingArchiveTurn`。只有 capture `toolOutput: full` 的工作区会把 policy 写进 progress；summary 工作区的 progress 没有 policy，所以每次提交都会读。
2. managed 路径的 `archiveJournal`（锁内）或 disabled 路径的 `matchingArchiveTurn`。

## 改动

- `findTraceArchiveTurnMatches` 改为异步：legacy 与精确轮次文件经 `inspectArchiveFileAsync` 并行读取，合并仍走 `mergeArchives`，校验与"精确文件无效就忽略"的规则不变。同步版本与只供它使用的 `readArchiveFile` 删除，没有留下 sync/async 双实现。
- `protectManagedInput` 在需要读归档找 pinned policy 时，返回这次读取结果（`archiveMatch`）。
- recorder disabled 分支在锁外，与保护步骤同在锁外，所以复用这次读取；保护步骤没读时（progress/journal 已有 policy）自己读一次。
- managed 分支的 `archiveJournal` 在锁内，**仍在锁内单独读取**。复用锁外结果会产生 TOCTOU：锁外读与锁内碰撞判定之间，其他路径（progress 恢复、disabled 提交）可能写入同一轮次。正确性优先，所以 managed summary 工作区仍读两次，只是不再同步阻塞主线程。
- `trace-turn-progress.ts` 恢复路径改为 await。
- `existingTurnDisposition`、`mergeArchives`、锁顺序都未改动，没有新增锁。

## 结果（L1）

| 场景 | legacy 读次数 前→后 | legacy 读字节 前→后 | 同步读 + 同步 lstat 前→后 |
|---|---|---|---|
| managed，progress，summary | 2→2 | 335,480→335,480 | 4→0 |
| managed，progress，full | 1→1 | 167,740→167,740 | 2→0 |
| managed，无 progress | 2→2 | 335,480→335,480 | 4→0 |
| recorder disabled | 2→1 | 335,480→167,740 | 4→0 |
| 非 managed progress 恢复 | 1→1 | 167,740→167,740 | 2→0 |

减少的工作去向：disabled 路径重复读取被删除（复用同一次锁外读取）；其余读取从主线程同步 I/O 移到 libuv 线程池异步执行，读取量不变。没有 L2 毫秒数据；不宣称用户可感知的耗时下降。

## 回归

- `disabled direct commit reuses the protection read and keeps a richer archive`：summary 工作区，复用读取仍判定 `existing_dominates`，不覆盖带 diff 的归档。
- `disabled direct commit still reads the archive when progress pins the policy`：full 工作区，保护步骤不读，disabled 分支必须自己读并拒绝覆盖冲突轮次。故意改成"只复用、不回退读取"时此例失败。
- `managed commit rejects an archived Provider turn with different content`：锁内碰撞判定保留。
- 三例在改动前源码上同样通过（行为不变）。
