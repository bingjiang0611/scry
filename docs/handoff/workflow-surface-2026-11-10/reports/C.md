# C · 真实 App 中的视觉与交互证据

状态：**部分完成，待核验**。凡需要真实 Claude Code 会话才有意义的检查项（运行中 / 失败 / 停止）被 B 的 Provider 阻塞连带卡住，尚未执行；与真实会话无关的部分已在真实 App 中跑通。

所有截图都在 `evidence/screens/`，都由 `npm run test:workflow-archive`（真实 Electron App、真实指针点击、临时 userData 与 HOME）产出，不是手放的图片。

## 已覆盖（真实 App，两次启动）

| 检查项 | 做法 | 证据 |
|---|---|---|
| 完成后布局与内容 | 归档轮次回放：阶段、agent chip、终态 chip、脚本行、日志、用量 | `workflow-archive-surface.png` |
| 真实退出再启动 | 第二个进程不写任何测试数据，仍打开同一会话 | `workflow-archive-relaunch.png` |
| 渲染进程重启 | `Page.reload` 后重开会话 | `workflow-archive-reloaded.png` |
| 窄宽（面板拖到最小） | 真实按键驱动 `.panel-resizer` 到最小值（520px），逐项重验 | `workflow-archive-layout-pane-min.png` |
| 窄窗口 | 视口 900px 宽，逐项重验，横向溢出 0 | `workflow-archive-layout-narrow.png` |
| 宽/最大化窗口 | 视口 1600px 宽，逐项重验 | `workflow-archive-layout-wide.png` |
| 相邻路径：Agents 标签页 | 切到 Agents，断言没有列出该 Workflow 的任何 agent，再切回并重验 | 冒烟断言（无截图） |
| 相邻路径：另一个会话 | 切到同一归档但删掉 Workflow 活动行的会话：`状态未知`、0 阶段、0 agent，再切回并重验 | `workflow-archive-plain-session.png` |
| 从聊天卡片进入 | 先展开工具组，再点「在 Workflow 面板查看」 | `workflow-archive-chat.png` |
| 证据语义（终态） | 断言状态 chip 的 tooltip 等于 `WORKFLOW_STATUS_EVIDENCE[run.statusSource]`，即界面上写「已完成」时必须同时说明它来自 `task_notification` | 冒烟断言 |
| 证据语义（未知） | 只有脚本、没有活动行的会话显示「状态未知」，0 阶段 0 agent，不推断成功 | `workflow-archive-plain-session.png` |

每个宽度都跑同一套 `verify()`：阶段数、每阶段 agent 名与状态、脚本行数、终态、`data-observed`、面板与窗口横向溢出必须 ≤ 0。

| 检查项 | 状态 | 原因 |
|---|---|---|
| C7 其他 Provider 空态 | 未验证 | 本机装有 `pi`/`codex`/`opencode`/`qoder`，但冒烟用的临时 userData 没有注册任何非 Claude Provider 简历；在临时实例里注册 Pi（`添加 Pi Agent…` 菜单项）没有打开任何可交互界面，继续要改 Provider 配置链路，超出本轮范围。日常 App 的 Pi/Codex 会话没有被测试实例读取，以免把真实会话带进临时实例。 |

## 尚未覆盖（等 B 解除阻塞）

| 检查项 | 为什么现在不能做 | 需要的真实条件 |
|---|---|---|
| 运行中（有 agent 正在跑） | 需要真实 `workflow_progress` 连续到达 | 一次真实 Claude Code Workflow 调用 |
| 失败 | 需要真实失败终态事件 | 同上，且其中至少一个 agent 失败 |
| 用户停止 | 需要真实 `task_notification` stopped 或中断 | 同上，并在运行中按停止 |
| 收窄/最大化时的运行中流式刷新 | 同上 | 同上 |
| 真实会话重启恢复 | 归档回放已证明“从磁盘读回”，但真实运行中还涉及未收敛的运行时状态 | 同上，跑到一半退出再启动 |

## 已知限制

- 窗口宽度用 CDP 视口尺寸设置，不是拖拽窗口边框；面板宽度用的是真实分隔条按键路径。两者都在 `verify()` 下读同一份布局断言。
- 归档回放不启动任何 Provider（`window.scry.activeRuns()` 断言为空），所以它不能证明 Provider 侧的运行控制，只能证明读取与呈现。
