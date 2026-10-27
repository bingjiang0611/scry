# 会话打开性能爬坡（2026-10-27）

## 目标与现场

用户反馈：点击历史会话后几秒才切换，长会话更明显。

只读日常记录快照：`/Users/baobingjiang/scry-performance-archive/20261027-092934-session-open`。
当前 packaged build 的 `session_history.load` 共 26 次，p50 486.6 ms、p95 3054.8 ms、最大 3119.8 ms。两次 116 轮冷切换为 2747.1 / 3119.8 ms，其中 `archive_read` 为 2583.4 / 3027.7 ms。现场还有一个 1 轮、289 事件、约 6.6 MiB 的巨型 Turn。

实验分支：`perf/session-opening-20261027`，基线 `8a23f508`。所有毫秒实验均通过 `.agents/skills/scry-performance-climb/scripts/timing-run.mjs`；机器持续高负载，因此这些毫秒只作受控方向证据，不升级为可信 L2 或日常 L3。

## 1. 点击先发布目标会话壳

旧路径在 `loadSession()` 完成前继续显示旧会话。新路径立即发布目标 session、composer scope 和空正文壳；权威历史完成后再原子安装。加载期间仍禁止发送，旧会话正文不会挂在新会话标题下，快速切换可由新请求取代旧请求。

固定 Electron `same-provider-pending-history` 负载，历史 resolver 延后 8 帧：

| 指标 | 基线 | 候选 |
|---|---:|---:|
| 历史完成前已选中目标壳 | 0 / 7 | 7 / 7 |
| selection p50 | 84.1 ms | 9.2 ms |
| ready p50 | 92.0 ms | 92.5 ms |

两侧 load1 都约 119，`highLoad=true`。可靠结论是选择语义从“等待历史”变为“先切换真实壳”；毫秒绝对值不作 L2 宣称。

## 2. 同项目连续打开不再重写 recency

`rememberProject()` 原来每次打开同一项目的另一个会话都会重写 recent/project 文件。现在只有 canonical 项目或 removed 状态发生变化时才写；切换项目与重新激活已移除项目仍保留原语义。

固定工作量 `same-canonical-project=2`，5 次完全一致：

| 工作量 | 基线 | 候选 |
|---|---:|---:|
| `io.write.calls` | 3 | 0 |
| `io.rename.calls` | 3 | 0 |

受控 benchmark 的均值为 30.6810 → 0.0236 ms，但两侧 `highLoad=true`，只保留为方向证据。L1 结论是 3 次写与 3 次 rename 被真正删除，没有推迟到测量窗口外。

## 3. session diff 引用按 16 路有界并发读取

`hydrateNewestSessionSnapshots()` 对现场数百个内容引用逐个 `await`。每个引用仍执行完整读取和 SHA-256 完整性校验；只把互相独立的读取改为有界并发，不降低证据校验。

固定 384 个唯一 patch 引用、约 4.2 MiB：

| 并发 | 均值 |
|---:|---:|
| 1（基线） | 54.1903 ms |
| 8 | 22.4337 ms |
| 16（采用） | 16.9842 ms |
| 32 | 25.2647 ms |

全部 timing-run 都是高负载。16 路在本轮固定负载里最好；继续提高到 32 路已经回退，因此停止增加并发。

## 4. 巨型已完成 Turn 首屏只渲染最近 16 条活动

原 transcript 窗口只按 Turn 数触发。单个 289 事件 Turn 会完整构建 Markdown、thinking 和 tool DOM。现在仅对已完成或失败且超过 96 个可见事件的 Turn 生效：首屏渲染最近 16 条活动，并提供“显示更早的 N 条活动”按钮。运行中 Turn 不窗口化；选择一个被隐藏的旧事件会自动渲染完整流。

固定 289 个交错事件的 `AssistantTurn` server render：

| 初始可见活动 | 均值 |
|---:|---:|
| 全部（基线） | 144.43 ms |
| 64 | 45.56 ms |
| 32 | 22.80 ms |
| 16（采用） | 12.38 ms |

工作量计数由生产 `AssistantTurn` markup 直接统计：217 → 16 个 `model-text` 节点，下降 92.6%。16 条固定负载已低于一帧预算；继续减少会明显压缩默认上下文，因此本轮在此停止。

## 基线与门禁

新增 candidate baseline：

- `workspace.remember-consecutive/io.write.calls = 0`
- `workspace.remember-consecutive/io.rename.calls = 0`
- `renderer.giant-completed-turn/rendered.flow-items = 16`

基线通过 `npm run performance:propose` 写入 `scripts/performance-ratchet/data-flow.json`。完整 `performance:measure --compare 8a23f508` 通过；除上述两类工作量外，已有计数没有本轮回归。

## 停止条件与限制

本轮四条已到明确局部停止点：目标壳选择约一帧内发布；重复 recency 写为 0；diff hydration 的 16 路优于 8/32；巨型 Turn 固定渲染低于一帧。继续降低真实冷打开仍可能需要页面缓存、worker 或 diff 按需 IPC。这些属于更大的协议/缓存改造，本轮没有用未经验证的缓存或延后证据加载替代当前合同。

没有 L3 结论。需要安装新 build 后，在相同大会话上收集至少 30 个样本、2 个日常 journal session，并核对环境与数据健康，才能判断 2.7–3.1 秒长尾的真实下降幅度。

## 产物

原始测量与机器输出：`~/.local/state/scry-session-opening-20261027/`。
