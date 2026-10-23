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
