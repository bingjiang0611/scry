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

## E4 大规模运行的上限与耗时：未开始

计划：用 200–1000 个 agent 的合成快照断言主进程行数上限（128/批、2048 行）、renderer 每阶段节点上限（48）、日志条数上限；再测 `deriveWorkflowRuns` 在流式更新下的耗时，明显时改增量折叠，并按 CLAUDE.md 报告测不到的项为 unavailable。

## E5 用量诚实：未开始

计划：核对 `workflow_usage` 与总览/分析/账单的聚合是否重复计入，重复则修掉并说明数字来源变化。

## E6 停止控制：不做独立按钮

按 W.md：不做 workflow 专用的停止/暂停按钮，只在 C3 验证现有停止按钮对运行中 workflow 的实际效果。

## E7 B/C 中发现的其他问题

| 问题 | 处理 |
|---|---|
| 活动行先于 `tool_use` 到达时出现第二个“状态未知”运行 | 已修，见 `reports/D.md`「顺带修掉的缺陷」 |
| `ChatView` 未把 `onOpenWorkflow` 透传给对话流 | 已修（E1 负对照） |
