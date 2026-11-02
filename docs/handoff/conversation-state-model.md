# 对话 / 运行状态模型

状态：本轮（App `0.2.239` / 私有 CLI `0.2.56`）的实现合同。它描述**哪些事实可以互相推导，哪些不能**，以及每条事实来自哪里。不是发布记录，也不代替 `docs/agent/` 的验证门禁。

## 1. 五个独立维度

一次逻辑调用穿过五个维度。它们各自有证据，任何一个维度的结论都不能代替另一个：

| 维度 | 问题 | 权威来源 | 不能推出 |
| --- | --- | --- | --- |
| 接收 / 投递 | 这次输入有没有交给 Provider？ | 统一对话 `.scry` dispatch 回执（`accepted` / `not_sent` / `unknown`）、composer 持久 receipt | 不能推出这一轮已经完成 |
| Provider 生命周期 | Provider 的 transport 是否已经结束？ | `runtimePromise` settle、`runtime:provider_ended`、停止阶段 `providerSettled` | 不能推出执行成功 |
| 执行结局 | 这一轮是成功、失败、取消还是中断？ | Provider 终态、`status`、`error`、`isError` | 不能推出证据已经收口 |
| 证据收口 | 归档、diff、managed 结算是否写完？ | `.scry/records`、terminal archive 回执 | 不能推出用户已经看到 |
| 用户注意力 | 用户是否需要现在处理？ | 待回复问题、被阻断事实、未读终态 | 不能推出运行还在进行 |

三条全局禁令：

- **accepted ≠ completed**：回执只证明输入送达，不证明这一轮成功。
- **terminal ≠ completed**：终止可以是失败、取消或中断。
- **inactive ≠ completed**：没有活跃运行只说明没有正在跑的 transport；历史缺失就是 `unavailable`。

## 2. 发送结果：typed `not_sent`，不猜

`ConversationApi.send` 返回判别联合，不再用异常表达“可以证明没发出去”：

```ts
type ConversationSendResult =
  | { status: 'accepted'; runId: string; disposition: 'created' | 'duplicate' }
  | { status: 'not_sent'; reason: string }
```

- 只有**在 `beginDispatch` 之前就被宿主拒绝**的路径才是 `not_sent`：revision 变化、接续身份变化、缺少 fresh 确认、待交接项不一致、历史交接预算不足、fork 屏障、Provider 不支持历史交接。
- Provider runner 已经接手（`onProviderDispatchAttempt` 已调用，或 runner 已经返回）之后的所有失败，包括回执丢失、runId 不一致、结算失败，都不是 `not_sent`，仍然抛出 → renderer 记为 `unknown`，不重放。
- 重试同一 `commandId` 时返回**该次尝试的持久结果**：`not_sent` 的尝试仍然返回 `not_sent`，不会被说成 `accepted`。
- renderer 把 `not_sent` 写进 durable receipt（`pending.notSent`）。它**跨重启存活**，并且在页面没有对应记录时仍然是 known-not-sent，而不是退回 `unresolved`。清空 receipt、显式重发是用户动作，不自动发生。
- 页面回执优先：权威记录说 `not_sent` 时，receipt 只是副本。

## 3. Provider 原生终止 ≠ 成功

`resolveSettled` 这类布尔值曾经把“Provider 已结束”和“这一轮完成了”混在一起。现在由 provider 特定的映射给出 `TurnTerminal`：

| Provider | 原生 `stopReason` | `TurnTerminal` |
| --- | --- | --- |
| Claude | `end_turn`、`stop_sequence` | `completed` |
| Claude | `max_tokens`、`refusal`、`model_context_window_exceeded` | `failed` |
| Pi | `stop` | `completed` |
| Pi | `length`、`error`、`aborted` | `failed` |

映射表在 `src/main/conversation-turn-terminal.ts`。`toolUse`、`pause_turn`、缺失 `stopReason` 都**不是**终态：它们既不是完成，也不是失败。流式原生 reader 和内存回退（raw projection）使用同一张表，因此两条路径不会对同一个 `stopReason` 给出不同结论。

## 4. 归档缺失状态不得升级为成功

`entry.status ?? 'completed'` 曾经让“旧归档没有写状态”读成成功。现在 `src/main/trace-archive-turn-status.ts` 只从结构化证据派生：

- 顶层 `error` 存在，或 `result.isError === true` → `failed`
- 明确写了 `result.succeeded` / 结构化成功证据 → `completed`
- 其他 → `unavailable`

三种读取路径（indexed、stream_rebuild、monolithic）都使用同一派生函数。不 hydrate 正文、不从 prompt 猜测。侧聊呈现 `status`（`completed` / `failed` / `unavailable`）与 `terminal`（是否显式终止）两个字段，不再有 `settled`。

## 5. Provider settle 与本地收口分开

`src/main/bootstrap/run-settlement.ts` 里的顺序是固定的：

1. `runtimePromise` settle 的**同一 microtask** 记录 `providerSettled = true`、`localFinalizing = true`，并 `runStopLifecycle.settle(runId)` 取消所有未触发的停止升级窗口。此后 stop 控制不再调用 `interrupt` / `forceKill`（`requestRunStop` 直接拒绝，文案说明无可取消的 transport）。
2. 完成 / 失败处理器随后运行：读 turn diff、写 terminal archive、结算 managed 投递。
3. 最后 `finally` 关掉 registry 条目、释放 session baseline、关闭事件日志；只有这时 `localFinalizing` 变回 `false`。

`RunRegistry.unsettledStates()` / `unsettledControls()` 把 **`providerSettled !== true || localFinalizing === true`** 视为仍占用上下文，所以 admission 与删除在收口期间仍然被阻塞；`providerSettled` 只表示“不用再取消”，不表示“可以并发下一轮”。

## 6. 侧聊边界：任何显式终止轮次

侧聊快照边界不再是“最近一个成功轮次”，而是**最近一个明确终止且证据完整的轮次**：

- 允许 `completed` / `failed` / `cancelled` / `interrupted`，以及证据完整的历史终止轮次（`status` 未知但显式终止）。
- 快照保留原始 `status`，不把失败改写成完成。
- 默认边界就是最新终止轮次；其后的真实未终止尾部被排除。
- 未终止轮次出现在中间、后面还有终止轮次时拒绝，不静默跳过。
- 不产生空快照：没有任何终止轮次时明确不可用。

中文文案相应从「已完成」改为「已终止 / 稳定」，因为失败轮次同样是可用的对话边界。

## 7. Activity 必须呈现失败与阻断

`src/renderer/sidebar-activity.ts` 只有一份映射（`activityGroupOf`）：

1. 被阻断 / 等待用户回复（含远端 `pendingQuestions > 0`）→ 需要回复
2. 活跃 → 进行中
3. 显式 `completed` → 已完成
4. `failed` / `cancelled` / `interrupted` → 待查看
5. 未读证据 → 待查看
6. 其余（无结局、无未读）→ 不出现

因此本地与远端的终态失败都不会“消失”，也不会被说成完成；未知结局仍然不出现（缺失不是证据）。

## 8. 停止控制调用失败必须可见

`AgentStopPhase` 增加了 `interrupt_request_failed`：

- 取消调用抛错时，阶段如实标为 `interrupt_request_failed`，`providerSettled` 保持 `false`。
- 用户的停止意图**保留**：优雅窗口继续计时，到点仍按 run-scoped 规则升级。
- 重复请求只重播当前阶段，不重复调用 `interrupt`，也不重置窗口。
- UI（`run-stop-status.ts` + `RUN_STOP_COPY`）显示「停止请求未生效」，说明取消没有发出、这一轮可能仍在运行、终态缺失前不显示完成。
- `forceKill` 失败语义不变：`no_safe_force_kill` + `forceKillBlockReason: 'force_kill_failed'`。

## 9. 已实现的证据边界（未验证项另列）

- 本轮验证以 `src/main/conversation-*.test.ts`、`src/main/run-stop-lifecycle.test.ts`、`src/main/bootstrap/run-settlement.test.ts`、`src/renderer/sidebar-activity.test.ts`、`src/renderer/composer-pending*.test.ts` 为准；集成门禁见本轮交付报告。
- 未验证：真实 Provider 的 `max_tokens` / `refusal` 端到端表现只由映射表与单元测试覆盖，没有付费探针。
- 未验证：Linux 宿主上的安装与交互；本轮只在 macOS 宿主验证。
