# 对齐 Orchestration V2：差异清单与要做的事

维护者 2026-11-23 决定：**P6 暂停**，先把下面的事全部做完，不分阶段。执行任务单见 [W20](handoff/tasks/W20-v2-alignment.md)。

对照基线：
- t3code `8cf97b5f`：`docs/orchestration-v2/`、`apps/server/src/orchestration-v2/`。只读参照，不拷代码。
- Scry main `a764f7d3`。

结论：外层（后台服务、单事务提交、快照加 cursor 订阅）已经对齐，有些地方比 t3 更严。往里两层没有对齐：
- 持久化核心只有表结构，没有真正运转。
- ProviderSession、持久提示词队列、会话谱系、检查点、委派，在 t3 里是一等对象，在 Scry 里缺失或只有占位。

`P4-orchestration-design.md`「t3code 对照」表把这些都漏掉了，本文替代那张表里缺的部分。

## 0. 保留的有意差异（不改）

| 项 | t3 | Scry | 理由 |
|---|---|---|---|
| 推送 | WebSocket | mTLS lane 长轮询 | 沿用现有 lane 与授权（protocol §5） |
| 事件保留 | 约 1 天 | 30 天，保留期内必须可解码 | data §4.2 |
| 原始 Provider 帧 | 可轮转诊断日志 | 不进库，事件只引用证据 | PLAN |
| 串行化 | 每线程锁 + CAS 写守卫 | 全局同步决策 + 单事务 | Node 单线程，效果等价 |
| 回执 | 主键 `command_id` | `(command_id, actor)` 加载荷哈希冲突检查 | 更严 |
| 重启后的运行 | 可选「继续」 | 已派发的一律中断，不静默重发 | core §2.4。本文 C4 补一个**用户显式**的「继续」 |
| 终端里开的外部会话 | — | 不列进侧栏 | 维护者 2026-11-23（#175、#177） |

明确**不做**：PR 与会话关联及其监视、issue、访客分享、LLM 生成标题、assistant 段落流式。

以后再说（本轮不做）：全文搜索、会话内查找、项目设置、工作分支同步。

## A. 现存缺陷

**A1 编排层因逻辑错误锁死**
- 现状：`event-sink.ts` 提交失败时，除 `OrchestrationStoreError` 外一律 `tripFence`，SQLite 约束冲突也算。之后所有命令都返回 `orchestration_write_indeterminate`，直到重启。
- 已知触发：`turn.record_delivery` 用调用方给的编号插 `turn.began`（`orchestrator.ts:283-306`，调用方 `daemon/orchestration-authority-startup.ts:114-136`），撞上主键 `(session_key, ordinal)`（`schema.ts:72-88`）。
- 要做：
  1. 回滚后只拒绝这一条命令：`SQLITE_CONSTRAINT*` 和决策期不变量失败都归为 `illegal_transition` 一类的黏性拒绝。
  2. 只有 IOERR、FULL、CORRUPT、NOTADB 和 fsync 失败才锁死。
  3. `turn.record_delivery` 改为按 `run_id` 定位轮次；编号冲突在 `decide` 里拒绝。

**A2 「本会话内允许」每轮失效**
- 现状：`shared/runtime-input.ts:46-62` 的 `destination: 'session'` 规则只交给当轮的 Claude 或 Qoder CLI，进程随这一轮结束，规则也就没了。
- 要做：daemon 按会话绑定持久保存已接受的会话级规则，每次启动或复用 Provider 时重新带上。按钮语义与实现一致。
- C1 落地后，规则改由常驻会话承载，持久副本作为重建时的来源。

**A3 正常结束的运行不带结果证据**
- 现状：`daemon/orchestration-authority.ts:381-397` 只写终态，证据是 `['provider']`，没有 outcome，因此所有实时运行的 `last_run_outcome` 都是 `unavailable`。`run.provider_settled` 和 `run.finalized` 只由恢复流程写出（`recovery.ts:189-221`）。
- 要做：Provider 结束时写 `run.provider_settled`；trace 归档写完后写 `run.finalized`，带 recorder 记录得出的 `Evidence` outcome。

**A4 副作用卡在 pending；未知类型让启动失败**
- 现状：
  - `provider.run.stop` 和 `question.respond` 两类副作用写入后从不完成，一直挂到重启才作废（`orchestrator.ts:209-218,349-364`、`authority-commands.ts:73-90`）。
  - 恢复时遇到不认识的副作用类型会抛异常（`effect-policy.ts:42-50`、`recovery.ts:108`），后台服务起不来。
- 要做：由 B1 的 worker 执行并完成这两类副作用；不认识的副作用置为 `failed` 并记录，不中断启动。

**A5 共享进程上卡死的一轮停不掉**
- 现状：`run-stop-lifecycle.ts:133-145` 对共享进程一律 `no_safe_force_kill`，即使只有这一轮在用。
- 要做：优雅停止的窗口过后，如果该 Codex 客户端或 OpenCode server 的活动计数是 1，就回收它；只有确实还有其他运行在共用时，才报 `no_safe_force_kill`。

## B. 持久化核心

**B1 真正的 EffectWorker**
- 现状：outbox 只是记录，派发仍由 `RemoteDispatcher.pump` 读内存台账完成（`src/main/remote/remote-dispatcher.ts:106-140`）；`attempts` 从不递增，`lease_owner` 从不校验，`dispatchablePendingRunIds` 没人消费（`recovery.ts:157`）。
- 要做：按 t3 `EffectOutbox.ts`、`EffectWorker.ts` 的语义实现：
  - 用 `UPDATE … RETURNING` 领取；同一会话先进先出，前一条未完成时后一条不能领。
  - `succeed`、`retry`、`fail` 都要求租约持有者匹配；`attempts` 递增；退避为 100·2ⁿ ms，上限 30 s，最多 5 次。
  - 解码失败的行置为 `failed`，不阻塞队列。
  - outbox 的所有状态变化都在 EventSink 事务内完成；删除事务外的 `updateRunStartOutbox` 和 `requeueRunStartOutbox`。
  - 派发、停止、回答都由 worker 执行。
  - 落地后删掉两个没有生产者的 kind：`catalog.*`（扫描本来就是直接调用）与 `conversation.writeback`
    （会话轮次改在 daemon 终态路径结算，启动对账兜底，见 `reports/W20-5.md` 第九轮）。留一个没人投递的
    kind，等于在策略表里写一条假承诺。
- 收尾：`RemoteDispatcher` 改为 `orch_outbox` 的消费者；删除对内存台账（`shadow-mirror.ts`、`shadow-routing.ts`）的派发依赖；随后按真实职责给剩下的模块改名。

**B2 数据保留**
- 现状：`pruneEventsInDb`（`event-sink-maintenance.ts:164-193`）只有测试调用；outbox、正文和终态行都没有清理。而且以下正确性逻辑把 `orch_event` 当作持久索引：
  - `session.deleted` 墓碑（`native-session-lookup.ts:19-33`、`daemon/orchestration-catalog-scan.ts`）
  - 派发台账元数据（`dispatch-ledger-snapshot.ts:85-87`）
  - V6 迁移（`schema.ts:220-266`）

  所以直接打开现有的清理会让已删除的会话复活。
- 要做：
  1. 墓碑和身份绑定迁到独立的表里（见 B3），上面这些读取改为读新表。
  2. 按 t3 `ProjectionMaintenance` 做定时清理：先写 `pruned_through`，再分页删除；保留每条流的头部和仍被引用的锚点；不能越过任何 projection 的已应用位置（data §4.8，需要补「已应用位置」的元数据）。
  3. 清理 outbox：完成的保留 72 小时，作废或失败的保留 30 天。
  4. 运行到终态后回收正文（data §4.7）。outbox 载荷里的内联提示词一并清除。

**B3 身份绑定表**
- 现状：原生 id 常常直接就是 `session_key`；没有唯一约束；查到两条匹配时返回 undefined，于是新分配一个 key；墓碑只存在事件里。
- 要做：
  - 新建绑定表，`UNIQUE(provider, profile, cwd, native_id) → session_key`。
  - 新会话一律分配 app key（`native:<hash>` 或 UUID），不再复用 Provider 的 id。
  - 查到多条匹配视为错误，不新分配。
  - 删除墓碑写进绑定表。

**B4 回执增长**
- 现状：每次目录扫描有变化都会写一条新的永久回执（`orchestration-catalog-scan.ts` 的 `catalog-scan:<key>:<rev>:<hash>`）。
- 要做：
  - 设备和用户命令的回执、以及 `resolveIntent` 墓碑永久保留。
  - `system` 和 `effect:` 的回执随事件一起清理。
  - 扫描的命令 id 改为按会话加 frontier 稳定取值。

## C. Provider 运行层

**C1 ProviderSession 层**
- 现状：
  - Claude、Qoder、Antigravity 每一轮都新起 CLI（`agent-runner.ts:441`、`qoder-run.ts:183`、`antigravity-run.ts:215`）。
  - Codex 按配置缓存 app-server（`codex.ts:715-793`），但每一轮都重新 `thread/resume`。
  - Pi 只有 Rotom 配置有进程池（`pi-rpc.ts:221-281`），而且没有数量上限。
  - OpenCode 按工作区共用 server（`opencode-server-pool.ts:79-85`）。
  - 首 token 门禁用的是假 Provider（`P3-s1-absolute-cap.md`），所以真实的冷启动成本从来没测过。
- 要做：在 `src/host-runtime` 里实现由 daemon 管理的 `ProviderSessionManager`：
  - key：会话绑定 + continuationKey + MCP 指纹 + 权限模式 + 运行环境指纹。
  - 生命周期：打开、复用、释放（记录原因）、重建；空闲 15–30 分钟释放；有后台任务时保留，最长 4 小时；全局有上限，满了先淘汰空闲的。
  - 编排层可见：新增 `provider_session.opened` 和 `provider_session.released` 两种事件，或者一张 projection 表。运行记录里带 session id。
  - 一个运行就是会话上的一轮。参考 t3 `ProviderSessionTransitionPolicy`：模型或权限变化时，能在线切换的就在线切，不能的就重建会话并续接。
- 各 Provider 的做法：
  - Claude：流式输入的 `query()`，配合 `setModel`、`setPermissionMode`。
  - Qoder：同一套 SDK。
  - Antigravity：ACP 进程常驻。
  - Pi：所有配置都进池，并给池加上限。
  - Codex：一个实例服务所有会话，每轮不再重复 `thread/resume`。
  - OpenCode：并入统一的管理器。
- 能力声明（原 C5）：除了现有的分面，再加会话级和轮次级的能力集（能否在线切模型、能否 steer、能否注入历史、能否压缩），替代散落在各 Provider 里的分支判断。

**C2 中途插话（steer）**
- 现状：只有 Codex 和 Pi 支持原生 steer（`run-steering.ts:45`）。
- 要做：
  - 在 C1 的常驻会话上，Claude、Qoder 走原生输入。
  - 不支持原生 steer 的 Provider，用「中断后重启」实现：原输入的投递记为 accepted 或 unknown，沿用现有的证据规则。

**C3 后台任务与主动唤醒**
- 现状：
  - Claude 的后台任务只渲染（`normalize-hooks.ts:33-70`）：停不了，也没有实时输出。
  - Pi 和 Qoder 有后台任务时一直占着这一轮（`qoder-run.ts:184`、`pi-run-events.ts:86-95`），用户发不了新消息。
- 要做：
  - 模型答完，这一轮就结算。
  - 后台任务按会话跟踪，会话因此保持常驻。
  - 任务完成时以 `origin = 'agent'` 的运行唤醒会话（R12 已预留），并进入 D1 的队列。
  - Claude 增加 `stopBackgroundTask` 和实时输出尾巴（参考 t3 `ClaudeTaskOutputTail`）。

**C4 恢复**
- 原生续接失败、证明会话已不存在时：自动新开一个会话，并用续接规划器已经算好的缺失内容做交接（参考 t3 `provider_resume_fallback`），不要再让用户手动解绑。
- daemon 重启后：下一轮告诉 agent 哪些后台任务被取消了（参考 t3 `RestartBackgroundNote`）。另外提供**用户显式**的「继续」，带循环保护；仍然不自动重发。
- 用量限额：按 Provider 解析重置时间，形成带类型的 `usage_limit`；持久记录一个待恢复项；用户开启后，到点自动恢复，命令 id 确定性生成。现在只是 `error-classify.ts:39-47` 的字符串匹配。

**C5 空闲压缩**
- C1 落地后：Claude 会话在提示缓存即将过期前（提前 2 分钟）发送 `/compact`（参考 t3 `IdleCompaction`）。可配置，默认开启，实测成本后再确定最终默认值。

## D. 会话模型：权威从文件移到 `orchestration.db`

**D1 持久的提示词队列**
- 现状：队列只在 renderer 的 `useState` 里（`renderer/app-state.ts:235`、`remote-prompt-queue.ts:24-42`），退出或刷新就丢；手机和 Mac 互相看不到。
- 要做：
  - 新增 `run.queued`，带 `queue_position` 和 `queue_held`；排队的发送不再用 `session_run_active` 拒绝。
  - 当前一轮到终态时，由决策器放行队头；顺序参考 t3 `QueuedRunOrder`，把自动完成按请求时间穿插进来。
  - 停止时设置 `queue_held`。
  - 用户排的队在重启后保留（不受 pending 的 60 秒 TTL 约束）。
  - Mac、Desktop 远程和 iPhone 都显示宿主上的这份队列。

**D2 派发模式**
- `message.dispatch` 支持 immediate、queue、steer、restart 四种模式，分别对接 D1 和 C2。

**D3 谱系入库**
- 现状：`parent_session_key`、`root_session_key`、`lineage` 三列一直是空的；`session.fork` 和 `session.create` 只存在于决策器里，生产代码从来不提交；远程分叉（`run-fork.ts:198-262`）会丢掉父会话。
- 要做：
  - `forkConversation`、`finishFork`、侧聊创建、`forkSessionWithAuthority` 都提交带谱系的命令；镜像也带上谱系字段。
  - 补上 plan §10 声称已有的「谱系与文件一致」测试。

**D4 元数据以事件为准**
- 改名、置顶、归档、删除改为以调用方身份提交 `session.*` 命令，由事件驱动文件；会话文件降级为导出和兼容格式。
- 删除「镜像就是最终状态」这条隐含路径。

**D5 检查点与回滚**
- 要做：
  - 每轮 git 快照保留为 tree ref（参考 t3 的 `refs/.../checkpoints`）。
  - 新增 `checkpoint.captured` 和 `checkpoint.rollback_requested`，被回滚的运行标记为 `rolled_back`。
  - 「倒回对话」先做：基于原生 fork 边界。
  - 「恢复文件」只允许在受管 worktree 里进行（参考 t3 `CheckpointRestoreSafety`）。

**D6 详情快照分页**
- 现状：`subscribe-engine.ts:387-389` 一次读出全部 `orch_p_turn` 行。
- 要做：与 `firstPage` 的窗口对齐，带 cursor（参考 t3 的 10 轮、1 MiB 上限）。

## E. 文档纠偏（随代码一起提交）

- P4 设计「t3code 对照」表：加一行指向本文；「outbox 的地位」一行改为「t3 代码已有完整 outbox 与 worker，README 那句已过时」。
- data §4.7、§4.8 与 plan §10：凡是声称已实现但实际没有的（数据保留、谱系的 CI 断言），改成指向本文的对应条目。
- core §2.6：副作用结果的 id 写法以代码为准，或者改代码去符合文档，二者择一并写明。
- P6 各文档开头标注：「暂停，待 V2 对齐完成后按本文更新依赖再恢复」。在本文基础上需要补进 P6 设计的规则：提问只唤醒父会话一次、同级子任务的结果批量送达，以及 DispatchModeLimit。
