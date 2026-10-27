# 20261027 点击到可用：本批三条等待

用户报三处「点了要等几秒」：切换会话时发送框先显示占位权限再跳到本机完全访问；发送时「正在准备工作区，尚未确认启动…」；打开分析页「正在读取本机用量账本…」。

数据来源：日常记录快照 `~/scry-performance-archive/20261027-0220`，运行中的 packaged build `bfebcfdf19a125a0dcb85b0239a63939c632f04f9b279e3bf2e6e28b1d0561f7`（App 0.2.226，单会话 5113 条）。该 build 对应的源码 commit 未确认：本机检出算出的 build ID 是 `4380b2db…`（`c975d8e4`）与 `8effea91…`（master `88434a67`），都不是运行中的 build，所以这里只把日志当作「当前运行 build 的观测」，不声称它包含本批优化。

| 慢点 | 证据（该 build） | 处理状态 |
|---|---|---|
| 切换会话等 Pi 目录 | `ipc.agent:runControls` p50 2074 ms / p95 4147 ms（n=42）；`pi.catalog.probe` p50 1996 ms，其中 `first_response` 2081 ms 是 Pi CLI 冷启动 | [已改源码，待 L2/L3](20261027-session-switch-run-controls.md) |
| 分析页首屏 | `ipc.agent:usageAnalytics` p50 4440 ms / max 5254 ms（n=2）；账本 SQL 仅 0.12 s，Credit 投影读原生 transcript 占主要开销 | [已改源码，待 L2/L3](20261027-analytics-first-paint.md) |
| 准备工作区 | `workspace.prepare` p50 4461 ms / max 9270 ms（n=2），其中 `git_prepared` 3351 ms / 7702 ms | 未改。`git worktree add` 的文件写入成本，需单独实验：并行准备多个仓库、准备期间保持进度可见、或调整准备顺序。先测再动 |
| 会话打开数据 | `ipc.agent:loadSession` p50 592 ms / p95 1733 ms；`session_history.load · archive` p50 356 ms | 未改。Pi 历史 `enrich` 会等目录探测（与切换会话同一个 2 秒）；可考虑有界的后台补全，但会让上下文用量证据从 `inferred` 退回 `unavailable`，需先定规则 |

同一 build 上的其他大项（不在本轮范围）：`ipc.workspaceSelection:read` p50 828 ms、p95 3345 ms；`ipc.agent:gitDiff` p50 543 ms；`ipc.desktopRemote:catalog` p50 214 ms × 297 次、`ipc.desktopRemote:trace` p50 449 ms × 71 次，属远端轮询的后台成本；`agent.first_text` p50 14.5 s 是模型耗时，不是 Scry 代码。

共同根因：`pi.catalog.probe` 的 2 秒是 Pi CLI 冷启动，它同时拖慢切换会话、命令目录与历史补全。要做到毫秒级需要常驻/预热 RPC 进程池（架构级，需维护者决定），或者放宽“不共享已巩固能力快照”的规则。

未测：本轮没有在独立 test 实例用 `timing-run.mjs` 重放任何一条 L2；机器 load 16–45，毫秒结论不可信。

> 备注：`docs/performance-opportunities.md` 已超过仓库的暂存文件体积门禁（>20 KB），本批索引暂时放在这里，等该日志拆分后再迁回。
