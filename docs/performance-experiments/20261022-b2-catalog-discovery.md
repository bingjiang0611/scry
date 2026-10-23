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
