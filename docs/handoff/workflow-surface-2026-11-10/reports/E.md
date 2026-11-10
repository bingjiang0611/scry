# E：补齐功能与文案

逐条记录。E1 已完成；E2–E5 见下方状态。

## E1 从聊天区打开面板：完成

做法：聊天里的 Workflow 工具卡片加一个入口按钮“在 Workflow 面板查看”，点击后打开右侧 Workflow 标签并选中**这次**运行（按 `tool_use` id 定位，不选最新）。

- 新增 `src/renderer/workflow-focus.ts`：外部 store（`requestWorkflowRun` / `useWorkflowRunRequest`）。面板由 shell 挂载，聊天卡片和面板不在同一棵树里，用 store 传一次“要看哪次运行”的请求，不新增 IPC。
- `app-interaction.tsx` 的 `openWorkflowRun`：写入请求 → `surfacePane.restore()` → `handleRightSurfaceAction({ type: 'open', kind: 'workflow' })`（和 `onOpenAgents` 同一套 shell 动作）。
- 回调沿 `app-chat-props` → `ChatView` → `chat-view/transcript` → `ChatTurnAssistant` → `ChatTurnTools` 传递；`ChatTurnToolItem` 仅在 `ev.tool === 'Workflow'` 且拿到回调时渲染按钮（拿不到回调就不显示，避免点了没反应的按钮）。
- `WorkflowSurface` 消费请求：`workflowRunForToolUse(runs, toolUseId)` 命中才切换选中；运行不在已加载历史里时保持原选择，不凭空造运行。
- 文案集中在 `WORKFLOW_COPY.openFromChat`，样式在 `workflow-surface.css`。

测试：

| 测试 | 覆盖 |
|---|---|
| `src/renderer/workflow-focus.test.ts`（2） | 请求写入/订阅；空 id 不产生请求 |
| `src/renderer/workflow-runs.test.ts`「聊天卡片按 tool_use id 找到自己的运行…」 | 同会话两次运行各自可定位；陌生 id 返回 undefined |
| `src/renderer/components/ChatTurnToolItem.workflow.test.tsx`（4） | 卡片显示入口与文案；无回调不显示；其他工具不显示；`ChatView` 会把回调传给对话流 |

负对照：把 `ChatView.tsx` 里新增的 `onOpenWorkflow` 透传临时移除，`ChatView 会把 onOpenWorkflow 传给对话流` 用例失败（`Tests 1 failed | 3 passed`），恢复后 4 个用例全通过。这条透传正是最初漏掉的一环：卡片渲染了按钮，但从会话视图到对话流的链路上丢了回调。

真实 App 验证：`npm run test:workflow-archive` 用真实指针点击聊天卡片的入口打开面板并通过断言（截图 `evidence/screens/workflow-archive-surface.png`，日志见 `reports/D.md`）。

## E2 文案以实测为准：等待 B

依赖 B 的实测结论（Q8 触发方式、Q1 事件字段）。代码与文案位置已确定：`src/renderer/constants/workflow-copy.ts` 的 `emptyBody` 与 `WorkflowSurface` 里的来源提示。B 拿到真实事件后按实测改写，并补一条“文案与事件来源一致”的测试。

## E3 脚本不可得时的说明：等待 B

依赖 Q9（按名称运行、内置 workflow 两种情况）。现有 `script.source`（`tool_input` / `task_started`）与 `phase N` 兜底已能显示，但缺少“标题被 Provider 隐去”的说明文案；B 实测后再补，避免凭猜测写提示语。

## E4 大规模运行的上限与耗时：完成

新增夹具 `workflowFixtureLargeMessages({ agentCount, snapshots })`（`src/shared/claude-workflow.fixture.ts`）：把 N 个 agent 摊到两个阶段，按真实 `system/task_progress` 全量快照下发，让归一化器走真实的增量分片路径。

| 测试 | 断言 |
|---|---|
| `src/main/normalize-workflow.large.test.ts`「1,000 个 agent…」 | 每个 canonical 事件 `rows ≤ 128`；`seq` 从 1 连续；`rowTotal` = 1,002（1,000 agent + 2 阶段行，此处按真实语义计入阶段行）；1,000 个 agent 各只投递一次；`rowsUnrecognized` = 0 |
| 同上「3,000 个 agent…」 | 跟踪行数封顶 2,048（含 2 行阶段 → 2,046 个 agent）；超出部分记进 `rowsOmitted`，不是静默丢弃 |
| 同上「归一化耗时」 | 1,000 个 agent × 6 份快照：**8–9 ms** |
| `src/renderer/workflow-runs.large.test.ts`「1,000 个 agent 折叠」 | 一次运行、2 个阶段各 500 个 agent、终态 completed、日志 ≤ 300 |
| 同上「每阶段最多渲染 48 个 chip」 | 渲染 chip 96 个（48×2），并显示“还有 452 个” |
| 同上「超出上限的运行…」 | `agentCount` 2,046、`rowsOmitted > 0`、`logDropped > 0`，面板显示“被省略”说明 |
| 同上「流式更新耗时」 | 40 次全量重折叠（每次处理 1,000 agent 的历史）：**合计 24–42 ms**，约 0.6–1 ms/次 |

结论：不需要改增量折叠。按 CLAUDE.md 的级别说明，这是 L2 级别的**单测内耗时**（同机、单次、无并发），不是 App 端到端毫秒；机器为 macOS 27.3 arm64，测试时本机另有 Electron 冒烟负载，未做空载对照，因此只用于“有没有明显回归”，不作为性能承诺。

节点数上限来自 `WorkflowFlow` 的 `MAX_AGENT_CHIPS = 48`（保留 running/failed 优先），日志上限 `MAX_LOG_ENTRIES = 300`，主进程上限 `MAX_TRACKED_ROWS = 2_048`、`MAX_TRACKED_TASKS = 64`、`WORKFLOW_ROWS_PER_EVENT = 128`。

## E5 用量诚实：完成，没有发现重复计数

核对结论：

- turn 总量、总览、分析、账单都只读 `harness/result` 事件（`resultOf` / `analyzeBilling`）；`workflow_activity` 上的任务级 `usage` 不进任何聚合。
- 落盘路径同样只认 result：`src/main/bootstrap/run-live-state.ts` 里只有 `ev.kind === 'harness' && ev.stage === 'result'` 才 `appendUsage`（`usage.jsonl` 与 SQLite 同源），workflow 事件不会写第二份。
- 面板把任务级用量单独呈现，并带“由 Claude Code 上报，是估算值，不是账单”的说明。

测试 `src/renderer/components/workflow-usage.test.tsx`（2 个用例）：

- 同一轮里 workflow 事件上报 26,600 tokens、provider result 上报 1,000/200，`analyzeBilling` 的 `totalTokens` 必须是 **1,200**（若任务级用量漏进总量会是 27,800）。
- 面板显示 `26.6k` 与 `WORKFLOW_COPY.usageNote`，且不会把本轮 1.2k 当成任务级用量。

未验证：真实 workflow 运行时 provider 的 result 是否已经把 workflow 子 agent 的 token 计入（这属于 provider 语义，需要 B 的真实数据才能确认）。若真实数据表明 result 已含子 agent 用量，面板与总量仍然不会双计，但“任务级用量”与“本轮总量”会有重叠解释，需要在 B 报告里写清。

## E6 停止控制：不做独立按钮

按 W.md：不做 workflow 专用的停止/暂停按钮，只在 C3 验证现有停止按钮对运行中 workflow 的实际效果。

## E7 B/C 中发现的其他问题

| 问题 | 处理 |
|---|---|
| 活动行先于 `tool_use` 到达时出现第二个“状态未知”运行 | 已修，见 `reports/D.md`「顺带修掉的缺陷」 |
| `ChatView` 未把 `onOpenWorkflow` 透传给对话流 | 已修（E1 负对照） |
