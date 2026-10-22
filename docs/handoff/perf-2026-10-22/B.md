# 批次 B：归档读写（#3、#4）

分支：`perf/handoff`，**等批次 A 在 STATUS 中标为 `已核验` 后再开始**。先读 [README.md](README.md) 与 [review.md](review.md) #3、#4。

这批直接涉及证据归档与 managed recorder 两阶段提交，属于 CLAUDE.md 的「跨核心持久化边界」：按 `docs/agent/verification.md` 的扩大 gate 验证，并先读 `docs/agent/change-checklists.md` 中受影响领域。

## B1（#4）一次提交只读一次归档，且异步

**先测**：在受控 workload（一份 legacy 长归档 + 继续写新轮次）中计数一次 `commitManagedTraceTurn` 内 `findTraceArchiveTurnMatches` 调用次数、读取字节、同步 I/O 次数（L1），单独提交。

**改法方向**
- 新增 `findTraceArchiveTurnMatchesAsync`（或改造现有函数），用 `inspectArchiveFileAsync`。
- `commitManagedTraceTurn` 内读取一次，把结果传给 `protectManagedInput`（`managed-turn-commit.ts:471`）、disabled 分支（`:688`）和 `archiveJournal`（`:492`）。注意 `archiveJournal` 在锁内执行、`protectManagedInput` 在锁外：若复用锁外读到的结果会产生 TOCTOU，就在锁内只读一次并在锁内使用，**正确性优先于少读一次**。
- `trace-turn-progress.ts:291` 同样改为异步。
- 同步版本若无其他非测试调用者，删除（避免继续出现 sync/async 双实现）。

**红线**
- `existingTurnDisposition` 的 conflict / existing_dominates / incoming_enriches 判定与输入完全不变。
- legacy 基表 + 精确轮次文件的合并语义（`mergeArchives`）不变；损坏的 canonical 轮次不得回退到旧副本。
- 锁顺序不变，不引入新锁。

**测试**：`managed-turn-commit.test.ts`、`managed-turn-notifications.test.ts`、`trace-turn-progress.test.ts`、`trace-turn-progress.regression.test.ts`、`transcript-archive.test.ts`、`commit-hook-trust*.test.ts`。

## B2（#3）启动不再全量扫描归档

**先测**：构造“N 个会话、M 个轮次、索引已 dirty”的 userData，测 `listProjects` 首次返回前读取的文件数、字节数、`JSON.parse` 次数（L1）；可行时补 L2 毫秒。单独提交。

**改法方向（择一，写明取舍）**
1. **增量索引**：写轮次时把该文件的 catalog 条目写入一个追加式增量文件（或 metadata sidecar 已有的信息），discovery 时“基础索引 + 增量”合并，只有增量损坏才回退全扫。
2. **缩小范围 + 移出首屏**：恢复只针对 qoder 子树（与 `index.ts:463` 的用途一致）；`listProjectCatalog` 不再 await 恢复，恢复结束后若记录了新会话，经 `agent:dataUpdated` 通知 renderer 刷新。

可以两者都做；至少消除“首屏等待全量扫描”。

**红线**
- catalog 只是恢复提示，崩溃后必须仍能正确重建（dirty 标记语义保留）：增量写入失败时退回“标 dirty/删索引”路径。
- 扫描期间并发写入不能丢（现有 `traceArchiveCatalogWriteGeneration` 机制保留或等价替代）。
- `writeTraceArchiveCatalogIndex` 改异步写，不在启动路径同步写最大 32 MB 文件。
- 不能把已归档的回归证据复活为新项目（`index.ts:465` 注释）。

**测试**：`transcript-archive.test.ts` 中 catalog/discovery 用例、`app-store.test.ts`；补“增量损坏 → 回退全扫”“扫描中并发写入不丢”回归；改 UI 刷新时机则跑 `npm run test:renderer:ui`。

## 完成后

写 `reports/B.md`，更新 [STATUS.md](STATUS.md)，push `perf/handoff`。
