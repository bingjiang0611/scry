# G1 · Qoder 部分：真实事件、canonical 事件与面板表现

> R2 的工作包 G1 要求四个 Provider 都做；本文件是其中 Qoder 一份。总览见 [G1](G1.md)。

**结论**：Qoder 在本机跑不起来（`Qoder CLI process exited with code 42`），`origin/main` 上同样如此，所以这不是本分支的回归。真实事件拿不到，因此「Qoder 的后台 Agent 不会显示成 Workflow」这一条**改用 SDK 声明的字段形状**验证，并做了负对照。Qoder 有没有 Workflow 能力：SDK 的 `SDK_DEFAULT_TOOLS` 里没有 `Workflow`，任务消息里没有 `workflow_progress`。

## 1. 真实运行：阻塞，且不是本分支引入

| 项 | 本分支 `0b107b74` | `origin/main` `f708285a` |
|---|---|---|
| 选中 Qoder 后发送 | 失败 | 失败 |
| 聊天区错误 | `Qoder CLI process exited with code 42` | **同一条** |
| tok / tools | 0 / 0 | 0 / 0 |
| Agents 面板 | 空：本会话尚未观测到子 Agent | 空，同文案 |
| Workflow 面板 | 空态（main 没有这个 Surface） | — |
| 事件日志 | 13 行：`hook_started`、`hook_response`、`input_receipt`、`credit_usage`、`summary`，无 `task_*` | 同样无 `task_*` |

归因见 [G1](G1.md) 的 Qoder 小节：用同一个 `@qoder-ai/qoder-agent-sdk@1.0.17` 在仓库外直接调用本机 `qodercli` 也是 exit 42；同机 `qodercli -p` 命令行正常。所以问题在 SDK 双向流路径，不在 Scry。

证据：`evidence/screens/g1-qoder-blocked.png`（分支）、`evidence/screens/g3-main-qoder-blocked.png`（main）。

## 2. 能证明的部分：Qoder 形状的任务事件不会变成 Workflow

依据 `node_modules/@qoder-ai/qoder-agent-sdk/dist/protocol/messages.d.ts`：

| 类型 | 字段 | 对判定的意义 |
|---|---|---|
| `SDKTaskStartedMessage` | `task_id`、`tool_use_id?`、`description`、`task_type?`、`workflow_name?` | 唯一可能命中判定的消息：`task_type` 是 `string`，不是字面量联合 |
| `SDKTaskProgressMessage` | 无 `workflow_progress` | Scry 的第二、第三条判定条件永远不成立 |
| `SDKTaskNotificationMessage` | `status`、`summary`、`output_file`，无 `workflow_progress` | 终态走 Agent 的 `tool_result`，不是 workflow |

Scry 的判定（`src/main/normalize-workflow.ts` 的 `isWorkflowTask`）只看三件事：`task_type === 'local_workflow'`、`workflow_progress` 是数组、或者这个 `tool_use_id`/`task_id` 已经在 workflow 里被跟踪。`workflow_name` 单独出现不算。

两条新测试（都是先写、都做了负对照）：

| 测试 | 断言 | 位置 |
|---|---|---|
| `Qoder 的后台 Agent 任务带着 workflow_name 也不进 workflow 通道` | `workflow_activity` 为 `[]`；任务作为 Agent 出现：`task_started`/`task_progress` 两条 `agent_activity`，终态是 `Agent` 的 `tool_result`（`agentStatus: 'completed'`） | `src/main/normalize-workflow.test.ts` |
| `其他 Provider 的后台 Agent 事件折不出 Workflow 运行` | 同样的事件折出的 `WorkflowRun` 是 `[]`（面板空态，不是「状态未知」的假 run） | `src/renderer/workflow-runs.test.ts` |

**负对照**：把 `isWorkflowTask` 改成「带 `workflow_name` 就算 workflow」，两条测试都失败（`2 failed | 20 passed`）；改回后 `22 passed`，`git diff src/main/normalize-workflow.ts` 为空。

## 3. 这条证据的边界（必须说清）

- 用的是**合成事件**，不是 Qoder 真实输出。字段名与可选性来自 SDK 类型声明，具体取值由我选定。
- 因此能证明的是「按 SDK 声明的形状，Qoder 的任务事件不会进入 workflow 通道」，**不能**证明真实 Qoder 会话里 Agents 面板显示正确（这条要等 Qoder 能跑起来）。
- Qoder 的 `task_type` 是 `string`：如果它哪天发一个 `task_type: 'something_workflow'` 的任务，Scry 会把它当后台 Agent 显示，Workflow 面板保持空态。这不是谎报（不会凭空造 workflow），但会漏掉。写进 G5 的设计说明。

## 4. 与 main 的对照说明

`origin/main` 的 build 里没有 Workflow Surface，所以「Workflow 面板不误判」在 main 上无法逐项对照；能对照的是 Qoder 的失败表现与 Agents 空态，两者一致（见第 1 节表格）。
