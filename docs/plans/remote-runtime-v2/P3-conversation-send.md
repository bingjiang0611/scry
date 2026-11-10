# P3 附录 · `conversation:send` 在 daemon 模式下的 run 跟踪

状态：维护者 2026-11-10 批准（参照 t3code，见 [STATUS-BATCH4](STATUS-BATCH4.md)），实现中。

## 问题

进程内的 `conversation:send` 由 `ConversationService.send` 完成：校验接续计划、准备交接历史、在会话账本里 `begin` 一个 turn，再调 `startAppRun(request, { managedConversation })` 启动一轮 run。

开关打开时，App 只能跟踪经过台账提交的 run（台账 `watch` → `bound` 标记 → 按规范 id 读 trace）。如果 daemon 直接调 `pipeline.startAppRun`，这一轮 run 不经过台账：App 看不到输出，停止和回答提问也到不了它。

## t3code 的做法，以及哪些能照搬

t3code 的发送是一条命令：先在一个事务里落盘意图，副作用队列里只存 `{ type: 'provider-turn.start', runId }`，worker 再从落盘状态重建输入。进程丢失后，这类与进程绑定的启动**直接取消**，不重建也不重发（`EffectOutbox.ts` 的 `PROCESS_BOUND_EFFECT_TYPES` 与 `reconcileAfterProcessLoss`）。

Scry 的交接有两样东西不在磁盘上：

- 被省略历史的读取源（`memoryHistoryReaderSource`）：选择历史时已经读进内存的正文；
- 交接预算（`contextUsage`、`modelContextWindow`）：同一次读取顺带得到。

要在重启后重建，就得把被省略的正文重新读一遍，这正是 t3code 自己也不做的事。所以照搬它的规则：**同一进程内，启动所需的内容从落盘读取并校验；跨进程丢失，启动取消。**

## 设计

1. **daemon 的 `startAppRun` 依赖改为提交台账。** `ConversationService` 本身不改。daemon 给它的 `startAppRun` 依赖做三件事：
   - 把 `{ request, managedConversation }` 登记到进程内的 `ManagedLaunches`，键是会话 turn 的 `runId`；
   - 以调用方（App 的本机 grant）身份提交台账 intent，`intentId` 是 `conversation-run:<runId>`。`detail` 只放可序列化的路由：cwd、provider、profile、显示用 prompt、`conversation: { conversationId, runId }`；附件不重复写进台账；
   - 返回的 Promise 在 run 真正注册后才 resolve，失败时 reject。这样 `send` 原有的 not_sent / unknown 结算逻辑原样生效。
2. **派发时取回。** `createRemoteRunBinding` 看到 `conversation` 标记时：
   - 从 `ManagedLaunches` 取出登记项（只能取一次）；取不到（daemon 重启过）就在启动 Provider 之前失败，原因 `conversation_start_unavailable`；
   - 规范 run id 用会话 turn 的 `runId`。运行管线本来就要求两者相等（`run-provider.ts`：「统一对话 runId 与 Provider 投递 runId 不一致」）；
   - 请求与附件用登记项里的原件，不走台账路径把文本附件内联进 prompt 的做法，否则输入 hash 会与回执对不上；
   - 台账路由里的 cwd、provider、profile 必须与登记项一致，不一致就拒绝。
3. **派发前被拒也要结算。** 台账在到达 binding 之前就可能拒绝这次 run（例如策略拒绝）。此时登记项还在，执行层把它标为失败，`send` 随之 reject，会话 turn 结算为 not_sent。
4. **本机 op 带上调用方。** `handleLocalOp` 把已验证的 peer 放进本次调用的上下文，台账提交用它，所以 run 的 scope 是 `local`，幂等也按 peer 区分。
5. **App 侧。** 闸门把 `conversation:send` 转给 daemon。daemon 的回答比进程内多一个 `ledger: { runId, seq }`；App 用它直接跟上这一轮 run（从 intent 的序号开始 watch，不从台账开头翻页），发 `conversation_changed`，再把 `{ runId, disposition }` 交给 renderer。重复命令且该轮仍在运行时，daemon 回答它当前的台账 run id。

## 重启的语义

- intent 已记录、尚未派发、daemon 重启：重启后的派发找不到登记项，台账记为带原因的 `run_failed`，Provider 没有被调用。会话 turn 由已有的启动恢复记为 `unknown`。严格说这一轮可以证明是 not_sent，但要让恢复区分它，需要在恢复前读取台账；这一精度改进记为后续项，当前结果不说谎，只是不够精确。
- 已派发、未结束、daemon 重启：与现有规则相同，台账与会话账本都是 `unknown`，不自动重发。

## 测试

- `ManagedLaunches`：登记、只取一次、派发前失败使 `send` reject、容量上限、取不到时失败。
- 路由：只有本机 scope 的 intent 能带 `conversation` 标记，设备提交带它会被拒。
- binding：带标记时用登记项的 run id、请求与 `managedConversation`；取不到时不调用 `startAppRun`。
- daemon 真实本机 socket：`conversation:send` 之后台账里有 intent，`bound` 的 `scryRunId` 等于会话 turn 的 `runId`，回答带 `ledger`。
- App：结果处理器按 `ledger` 跟上 run，再通知窗口；daemon 拒绝时不通知。
- 控制实验：binding 不取登记项时第三条失败。
