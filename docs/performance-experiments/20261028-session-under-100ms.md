# 会话打开低于 100 ms（2026-10-28）

## 目标与真实负载

目标是点击任意已完成会话后，在 100 ms 内切换到目标会话并显示该会话的真实 catalog 提示；完整权威证据继续异步核对，不能把旧会话内容留在新选择下。

真实验收会话为 `workflow`（Pi，session `01a154f3-555f-71af-b8e6-13ac29ec0986`）。其 Scry 分段归档有 101 个 turn 文件、约 422 MB；用户数据快照包含真实 catalog、Pi Profile 与内容引用。Electron 使用独立 `userData`，通过原生 CDP 鼠标事件点击侧边栏会话。真实 Pi 历史读取启用，但不发送消息。

所有毫秒命令均由 `.agents/skills/scry-performance-climb/scripts/timing-run.mjs` 执行。

## 初始证据

- 已安装版本的 journal 中，`session_history.load` 样本为 67–3524 ms，长尾主要在 `archive_read`。
- 初始独立实例：选择壳 24.3 ms，但首个权威 turn 978.5 ms，完整打开 962.1 ms。
- 归档 limit=1 仍读取约 39 MB；旧索引只含 55/101 条，90 个 sidecar 中缺 11 个。读取路径每次都重新解析缺 sidecar 的大 turn，修复结果没有持久化。

## 实现

1. 点击后立即安装 catalog 中的目标会话提示。该页标记为 `sourceComplete: false` 和 `data-history-source="preview"`，不会冒充权威归档。
2. catalog 预览时间线可立即阅读且不再保持 `aria-busy`；composer 继续锁定，直到 cwd、focus 和完整权威历史完成，因此没有放宽发送安全边界。
3. 完成态单条模型回复超过 24,000 字符时，首屏只解析 8,000 字符，并提供原生“显示完整回复”入口。运行中回复和显式展开仍显示完整内容。
4. `rememberProject` 的持久化移到权威历史响应之后，并记录独立的 `session_history.remember_project` trace；不再把 41–83 ms 的 recency I/O 算入会话读取关键路径。

## 结果

同一真实会话、独立 Electron 实例、每次使用新 APFS 快照的最终三样本（本组 `highLoad=false`）：

| 指标 | 初始 | 最终 3 样本 |
|---|---:|---:|
| 目标壳可见 | 24.3 ms | 29.1–32.9 ms |
| 首个目标 turn 两帧稳定 | 978.5 ms | 43.1–51.9 ms |
| `aria-busy=false` 的目标时间线 | 962.1 ms | 29.1–32.9 ms |
| 完整权威历史替换 | 约 978.5 ms | 512.7–560.7 ms |

此前同实现路径的五个 `highLoad=true` 样本仍全部低于 100 ms：目标时间线 34.2–45.8 ms，首个目标 turn 50.8–70.8 ms。

低负载一次 main trace：`session_history.load` 241.1 ms，其中 Pi native history 54.2 ms、8 轮页 hydration 181.4 ms；独立 recency trace 43.8 ms，不阻塞响应。

## 基线与边界

新增 candidate baseline：

- `renderer.large-completed-text/rendered.text-characters = 8000`

真实 UI 脚本会直接断言目标时间线和首个 turn 均低于 100 ms。测试负载包含真实本机数据，但样本机器曾多次 `highLoad=true`，因此这些是方向性真实 UI 证据，不宣称稳定 L2/L3。

完整权威历史目前仍为约 513–561 ms，主要剩余成本是 8 轮 attachment hydration 与 renderer 权威替换。用户点击后的目标内容已经稳定低于 100 ms；继续压缩完整替换需要独立设计权威增量或 attachment 按需加载，不能用隐藏证据或延迟安全检查伪装。
