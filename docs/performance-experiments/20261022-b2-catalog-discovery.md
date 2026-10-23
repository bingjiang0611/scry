# 20261022 B2：启动时的归档目录发现

- 路径：冷启动 → renderer 调 `agent:listProjects` → `listProjectCatalog` → `await recoverTraceCatalogOnce()` → `discoverTraceArchiveSessionsAsync`。
- 来源：`docs/handoff/perf-2026-10-22/review.md` #3，静态审查，未测量。
- 基线源码：`d0a4490`（B1 之后，B2 改动之前）。

## L1 采集器

`src/main/trace-catalog-discovery.measurement.test.ts` 用真实 `upsertTraceArchiveTurn` 写入 5 个 Provider × 10 个会话 × 4 轮 = 200 个 per-turn 文件（其中 Qoder 40 个）。写入会留下 dirty 标记，与"上次运行写过轮次"的启动相同。采集器在 fs 边界统计 per-turn 文件读取次数与字节、`JSON.parse` 次数，以及索引发布方式（同步 `renameSync` / 异步 `rename`）。

```bash
npx vitest run src/main/trace-catalog-discovery.measurement.test.ts
```

### 基线（`d0a4490`）

| 指标 | 值 |
|---|---|
| per-turn 文件读取 | 200 次 |
| 读取字节 | 91,320 |
| `JSON.parse` | 200 次 |
| 索引发布 | 同步 1 次，异步 0 次 |
| 返回会话摘要 | 50（Qoder 10） |

基线中 `listProjectCatalog` 先 `await` 这整次发现，所以上表全部工作都在首次项目列表返回之前完成。recovery 只使用 Qoder 摘要，其余 160 个文件的读取和解析只为写全局索引。

## 方案取舍

选 B.md 的方案 2（缩小范围 + 移出首屏），不做增量索引：

- 增量索引要新增一种持久化格式及其损坏回退，而 catalog 的唯一生产用途是 Qoder 补缺。方案 2 不新增持久化文件，能直接消除"首屏等全量扫描"。
- 代价：每次写轮次（任何 Provider）仍会把索引标 dirty，所以活跃用户的下次启动仍会后台重扫 Qoder 子树。这部分工作不在首屏路径上。若 Qoder 归档变大并在后台造成可观察负载，再考虑方案 1。

## 改动

- `discoverTraceArchiveSessionsAsync(userDataDir, providers?)` 与 `scanTraceArchiveCatalogIndexAsync(..., providers?)` 可限定 Provider 子树。限定时发布的索引带 `providers` 字段；它只回答同一范围内的请求。同步 `discoverTraceArchiveSessions`（删除路径）与未限定的异步请求都不信任限定索引。
- 异步发现改为 `writeOwnedFileAtomicallyAsync` 发布索引，不再在启动路径同步写最大 32 MB 文件。发布后在同一同步步骤内复核 `traceArchiveCatalogWriteGeneration` 再 `unlinkSync` dirty 标记（异步 unlink 可能删掉新写入依赖的标记）。若发布期间有新写入，保留 dirty 标记并删除刚发布的索引，下次重扫。
- 恢复逻辑移到 `src/main/trace-catalog-recovery.ts`（`recoverQoderCatalogSessions`），只扫 Qoder，仍只记录已知 cwd 的会话，不复活归档的回归证据。
- `listProjectCatalog` 不再 `await` 恢复，只在后台启动一次。恢复新增会话后发送 `agent:dataUpdated { kind: 'catalog_recovered' }`，renderer 据此重新加载项目列表。恢复失败只记 warn（catalog 只是提示），下次启动按 dirty 索引重试。
- 删除路径的 `rebuildTraceArchiveCatalogIndex` 仍同步全量扫描并同步写索引。它不在启动路径，本批不改；见报告未验证项。
