# P3 附录 · `conversation:send` 在 daemon 模式下的 run 跟踪（方案，待批准）

状态：方案，未实现。`conversation:send` 目前仍被闸门拒绝（见 [b4-l4](status/b4-l4.md) L4-2b）。

## 问题

进程内的 `conversation:send` 由 `ConversationService.send` 完成，步骤如下：

1. 校验接续计划并准备交接历史；
2. 在会话账本里 `begin` 一个 turn；
3. 调用 `startAppRun(request, { managedConversation })` 直接启动一轮 run。

`managedConversation` 中有若干只能存在于内存的东西：

- `prepareInput`、`onProviderDispatchAttempt`、`onTerminal` 三个闭包；
- 打开着的 `historyReader` 连接；
- 冻结的 `historicalContext`。

`onTerminal` 负责把 Provider 回执与归档结算回会话账本（accepted / not_sent / unknown）。

开关打开时，App 只会跟踪经过台账提交的 run，路径是：

- App submit → 台账 intent → `createRemoteRunBinding` 派发 → `bound` 标记；
- App 的 `DaemonRunRuntime` 用台账的 `watch` 等到 `bound`，再用规范 id 读 trace。

如果在 daemon 里照原样调用 `pipeline.startAppRun`，这一轮 run 不会经过台账。App 拿不到台账 run id，所以：

- `adopt` 找不到它；
- 窗口没有流式输出；
- 停止和回答提问都到不了它。

结果就是一轮看不见、也停不下来的 run，这正是 G1 要杜绝的情况。

## 方案 A（推荐）：会话发送也走台账，内存里的部分按台账 run id 交接

1. **daemon 侧的 `startAppRun` 依赖改为提交台账。** daemon 里 `ConversationService` 的 `startAppRun` 不再直接启动 run，而是：
   - 先登记一个台账 intent，与 App submit 走同一个 `submit`，`scope: local`；
   - intent 的 `detail` 里只放可以序列化的路由信息：cwd、provider、profile、model、effort、permissionMode、resume，以及 `managedConversation: { conversationId, runId }` 标记；
   - 闭包、reader 和历史上下文放进进程内的 `ManagedHandoffs` 表，键是台账 run id；
   - `send` 的回答比进程内多一个字段 `ledgerRunId`，其余不变。
2. **派发时取回交接。** `createRemoteRunBinding` 发现 intent 带有 `managedConversation` 标记时，从 `ManagedHandoffs` 取出对应项并原样传给 `startAppRun`：
   - 规范 run id 使用会话 turn 的 `runId`，不再新生成。renderer、会话账本与 trace 必须是同一个 id；
   - 附件按进程内的 `prepareInput` 处理，不走台账路径上把文本文件内联的做法。否则输入正文的 hash 会与回执对不上。
3. **取不到交接时按失败处理（fail closed）。** 例如 daemon 在 intent 与派发之间重启过：
   - 不启动 Provider；
   - 写 `run_failed`，原因 `managed_handoff_lost`；
   - 会话 turn 由已有的启动恢复（`getStartupManagedRecovery`）结算为 `not_sent`，因为输入确实没有投递。
   - 不按普通提示词重跑：那样会丢掉历史交接，而且回执 hash 必然对不上。
4. **App 侧拆成 split。** 闸门把 `conversation:send` 转给 daemon，结果处理器依次：
   - 用 `ledgerRunId` 调 `DaemonRunRuntime.adopt` 并启动 pump，与 `agent:start` 共用同一套跟踪；
   - 发 `conversation_changed`；
   - 把 `{ runId, disposition }` 交给 renderer。
5. **重复命令。** `disposition: 'duplicate'` 时，daemon 按会话 turn 的 `runId` 去查台账：
   - 这轮 run 仍在运行，就回传它的 `ledgerRunId`，App 照常 adopt；
   - 已经结束，就不回传，窗口从会话账本读结果。

停止、回答提问和结果未知的语义，都沿用台账已有的规则，不新增 op。

### 需要先核实的三点（写代码前做，结果记入 status）

- 台账派发路径上 `origin: 'remote'` 与 `grantScope: 'local'` 的组合：确认 managed recorder、证据、权限都按本机语义处理。`permissionModeOverride` 已经按 `grantScope` 区分，但 `origin` 还被其他地方读取，需要逐个列出。
- 规范 run id 能否由调用方指定。`nextScryRunId()` 目前在 binding 内部生成，`bound` 标记依赖它。
- 进程内 `send` 的 `active` 集合与 `settle` 在 daemon 中照常运行，结算由 daemon 完成；App 不再参与结算。

### 测试（先写失败测试）

- daemon 真实本机 socket：send 后台账里有 intent，并出现 `bound`，其 `scryRunId` 等于会话 turn 的 `runId`；App 的 `DaemonRunRuntime` 能 adopt 并读到文本；停止后会话 turn 结算为终态。
- 交接丢失：先登记 intent，清空 `ManagedHandoffs` 后再派发，结果是 `run_failed: managed_handoff_lost`，Provider 未启动，turn 结算为 `not_sent`。
- 重复命令：运行中的重复发送回传同一个 `ledgerRunId`，结束后的重复发送不回传。
- 控制实验：去掉 binding 里取交接的逻辑，第一条测试失败（run 以普通提示词启动，回执 hash 不匹配）。

## 方案 B（不推荐）：不经台账，App 按规范 id 直接读 trace

daemon 直接启动 run，把规范 id 回给 App，App 只靠 trace 跟踪。问题：

- 生命周期要从 trace 里推断；
- 停止和回答提问需要新增本机 op；
- App 里会出现第二套 run 跟踪；
- daemon 重启后，App 无法区分“run 丢了”和“结果未知”。

这与“优先扩展现有 contract，不建立第二套同义状态”相冲突。

## 方案 C：在 B4-S 之前保持拒绝

开关默认关闭，用户不受影响。代价是开关打开时统一对话无法发送，L4 的覆盖也就不完整。

## 需要维护者决定

是否按方案 A 实现。批准后先做上面三点核实；如果核实结果推翻了方案中的前提，会先停下来报告，不直接改方案。
