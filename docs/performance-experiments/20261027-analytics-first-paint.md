# 20261027 分析页先显示账本，Credit 投影改为后取

## 现象与证据

打开「分析」页面先看到「正在读取本机用量账本…」，数秒后才出现数据。

日常记录（快照 `~/scry-performance-archive/20261027-0220`，运行中 packaged build `bfebcfdf19a125a0dcb85b0239a63939c632f04f9b279e3bf2e6e28b1d0561f7`，App 0.2.226）：

| 路径 | 操作 | p50 | max | n |
|---|---|---:|---:|---:|
| analytics | `ipc.agent:usageAnalytics` | 4440 ms | 5254 ms | 2 |

样本少（只开了 2 次页面），但与用户体感一致，按线索处理，不作成熟基线。

拆分证据（在用户数据库的只读副本上测，`/tmp/scry-perf-db/scry.db`，499 MB）：

- 账本 SQL 部分：`usage_ledger` 近 28 天 2370 行，`sqlite3` 计时 0.12 s。这不是问题所在。
- Credit 投影部分：28 天内 qoder/pi 的 run scope 有 330 条，`readQoderCreditRows` 会按会话逐个读 trace archive + 原生 Pi session（总预算 64 MiB、上限 200 个会话）并解析，串行执行。这才是那 4 秒。

## 改动

- `src/main/bootstrap/agent-runtime-ipc.ts`：`agent:usageAnalytics` 只返回 SQLite 账本快照（`usageAnalyticsQuery`），新增 `agent:usageCredits` 返回含 Credit 投影的结果（原 `usageAnalyticsWithCreditsQuery`，远端 host 路径不变）。范围校验合并为一个 `usageRange`。
- `src/preload/index.ts` / `src/preload/index.test.ts`：暴露并登记 `usageCredits` 通道。
- `src/renderer/hooks/useUsageInsights.ts`：第一段结果立即提交并结束 loading，第二段在后台请求；范围/序号变化时丢弃过期结果；第二段失败或范围不匹配时保留账本快照。
- `src/renderer/components/AnalyticsView.tsx`、`AnalyticsChart.tsx`、`constants/copy.ts`：Credit 未就绪时证据文案写「正在计算 Credit；当前只显示用量账本记录」，不再写成「Credit 不可用」（未知 ≠ 不存在）。数值仍只显示账本已知成本，未完成的 Credit 不参与。
- `scripts/performance-paths.json`：`ipc.agent:usageCredits` 归入 analytics 路径，`scripts/performance-feedback.test.ts` 的通道分类检查通过。

## 验证

- `npx vitest run src/renderer/components/AnalyticsView.credits.test.tsx`：新增一例，`creditsPending` 时出现「正在计算 Credit」且不出现「Credit 不可用」，成本仍显示未确定；Credit 确定后回到精确证据。
- `npx vitest run src/preload/index.test.ts scripts/performance-feedback.test.ts src/renderer/hooks`：18 文件 153 例通过。
- `npm run typecheck`（node + web）通过。
- 全量 `npx vitest run` 见提交说明。

## 减少的工作去了哪里

移出关键路径：Credit 投影（4.4 s 量级）不再挡首屏。工作量本身没有减少，账本数字先出现，Credit 与可换算成本随后替换。

## 级别与后续

- L1：页面首屏不再等待 Credit 投影；两个通道各自仍按原工作量执行（`ipc.agent:usageCredits` 保留 4 s 量级耗时，未伪装成变快）。
- L2：未测。真实 App 首帧预期由 4.4 s 降到账本 SQL 的 0.1 s 量级（依据：数据库副本 0.12 s + IPC 开销），需要在 test 实例里用 `timing-run.mjs` 重放。
- L3：待部署后按同场景 ≥30 样本、≥2 会话对比。
- 后续可选（未做）：按原生 session 文件身份（路径 + size + mtime）缓存 Credit 投影，把第二段本身降到毫秒级；或限制默认范围。两者都会改变证据新鲜度语义，需先定规则。
