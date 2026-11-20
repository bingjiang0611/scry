# P4 · §2 核心模型

属于 [P4 设计](P4-orchestration-design.md)。行号说明见总体设计开头。本文是评审后（2026-11-18）新拆出的一节，收进原 §2.1–§2.4 与评审要求补上的规则。

## 2.1 Orchestrator

- 输入：已准备的命令 `{ commandId, actor, scope, type, payload, prepared }`。`actor` 是证书指纹（远程）或本机 grant 指纹。
- `commandId` 按 actor 作用域。设备 intent 沿用 `scopedIntentId`：定义在 `remote-gateway.ts:119-122`（`peer\0intentId` 的哈希排成 UUID 形状），调用处 `:197`、`:227`、`:239`。
- 决策：`decide(command, view) → { events, effects, receipt }`。`view` 是 projection 的只读视图。
- run 状态机取自 `SessionLedger` 的转移表 `NEXT`（`session-ledger.ts:102-108`）与重复检测（`:295-307`），抽成纯函数后原样复用。
- 决策器不做 I/O。异步工作在它之前（§2.3）或之后（§2.6）。

## 2.2 拒绝：黏性与可重试

沿用 `command-receipts.ts:11` 的「失败不缓存」，按「同一载荷是否永远得到同一结果」分两类：

| 类 | 例 | 回执 | 同 id 重试 |
|---|---|---|---|
| 黏性 | `command_payload_conflict`（今天的 `intent_payload_conflict`，`session-ledger.ts:300`）、`illegal_transition`、`invalid_target`、`resolveIntent` 墓碑（data §4.3） | 写 `rejected` 回执，永久保留 | 返回同一拒绝，不重新决策 |
| 可重试 | 同会话已有 run、容量满、`provider_authenticating`（`remote-run-policy.ts:65`）、授权当时无效、存储 fail closed（§2.5） | 不写回执、不写事件 | 重新决策 |
| 事务失败 | IOERR、FULL、fsync 失败 | 什么也没提交 | 见 §2.5 |

授权失败不写回执：未授权的对端不能在库里留下持久行。

## 2.3 准备、决策与派发前复核

1. **准备**（异步，进入决策器之前）：canonical cwd（`realpath`）、工作区授权、trust 指纹、附件已提交、正文已落盘（data §4.7）。结果固定在 `prepared`。
2. **决策**只看 `prepared` 与 projection，不碰文件系统。
3. **派发前复核**：effect worker 在调用 Provider 之前，每次都做，immediate 路径也做。准备阶段的结果不是授权缓存。

| 复核 | 依据 | 失败时 |
|---|---|---|
| `realpath` 仍等于固定的 canonical cwd | `prepared.cwd` | `run.failed(cwd_changed)` |
| 工作区授权 | `RemoteRunPolicy.authorize`（`remote-run-policy.ts:46-66`） | `run.failed(workspace_not_authorized)` |
| 提交者的 grant 仍有效：未撤销、未过期；本机 grant 仍是当前那份 | `pairing-state.json`，不读事件日志 | `run.failed(grant_revoked)` |
| 操作闸门：同 provider/profile 的认证互斥 | `acquireOperation`（`remote-run-policy.ts:63-65`） | 留在 `pending`，受 TTL 约束（§2.4） |
| trust gate：canonical cwd + 内容/executable 指纹 | 现有 gate | `run.failed(trust_gate_rejected)`，fail closed |

这些检查今天的 run 管线大多已做；首 token 路径上新增的只有一次 `realpath` 与一次 grant 查表，P4-2 实测（plan §8）。

## 2.4 派发与重启（决定 B，维护者 2026-11-18）

**立即路径与派发栅栏（2026-11-20 `fullfsync=ON` 决定后修订）。** 当全部 §2.3 派发前复核与准入检查在提交前同步通过时，一个事务原子提交 `run.intent_recorded`、`turn.began`（会话 run）、`run.admitted`、`run.dispatched`、回执与已领取的 outbox 行（`state='running'`、`lease_owner`、`claimed_at`），**然后**才调用 Provider。首 token 前因此只需 **1 次** `F_FULLFSYNC` 提交（满足 plan §8 的 8 ms 门禁）；持久转移依然严格先于执行。若提交后、Provider 启动前进程崩溃，重启恢复按「已派发、无终态」处理：先查 recorder 证据，无证据则记 `run.interrupted`、投递状态 `unknown`（不再记 `not_sent`），绝不静默重发。

**排队与两步回退。** 准入当时拿不到（操作闸门被认证占用、容量满）或复核失败时，先在事务 1 提交 `run.intent_recorded`（认证占用时 outbox 留在 `pending`，带 `expires_at = intent 时刻 + TTL`，上限 60 s）；待闸门释放后，再经 §2.3 完整复核并提交第 2 次事务 `run.admitted` + `run.dispatched`（或拒绝/过期取消）。测试用 `SCRY_ORCHESTRATION_PENDING_TTL_MS` 调小，不改默认值。

**重启。** 在 `runStartupRecovery` 之后（`host-process.ts:218-226`）、开放 `local.sock` 之前，用一个恢复事务处理：

| 重启前 | 处理 | 结局 |
|---|---|---|
| `pending`（本库新提交），未过期 | 复核（§2.3）后派发一次 | 正常 |
| `pending`（从旧 H1 账本导入，`ownerActor='system'`） | 缺少持久化 peer 指纹，**不派发**：`run.cancelled(legacy_owner_unavailable)`；turn `not_sent` | fail closed，不绕过授权 |
| `pending`，已过期，或时钟回拨（现在早于 intent 时刻） | `run.cancelled(pending_expired)`；会话 run 的 turn 记 `not_sent` | 可证明未发送 |
| `pending` 的会话 run（交接在内存，H6） | `run.cancelled(conversation_start_unavailable)`；turn `not_sent` | 同 [P3-conversation-send](P3-conversation-send.md) |
| 已领取，没有 `run.dispatched`（两步路径） | `effect.voided` + `run.cancelled(host_restarted_before_dispatch)`；turn `not_sent` | Provider 从未被调用，可证明 |
| 已派发，没有终态（含合并提交后、Provider 启动前崩溃） | 先查 recorder 证据（§2.6）；能证明就按证据收尾，否则 `run.interrupted`，结局 `unavailable(host_restarted)`，turn 送达 `unknown` | 不是 `failed`，不静默重发 |
| 开着的提问 | 同一事务 `run.question_closed(host_restarted)` | |

**为什么改。** 今天重启后会把「已记录、未派发」的 intent 派发一次（`host-controller-surface.ts:107-117`）。P5 的登录时启动与无人值守重启会让重启更频繁，旧规则可能在几小时后派发旧提示，且可能带 `full_access`。新规则让已领取的进程绑定副作用一律作废（与 t3code 一致），只给排队中的 pending 留一个有界、经复核的例外。

## 2.5 提交失败：fail closed，放行停止

- 任何提交错误（`SQLITE_IOERR*`、`SQLITE_FULL`、fsync 失败）都让存储进入 `orchestration_write_indeterminate`，同 `session-ledger.ts:253-281` 的 `ledger_write_indeterminate`。之后所有命令按可重试拒绝，读返回 `unavailable` 与原因。
- **只收紧的动作仍放行**：停止、取消运行中的 Provider。它们经 `RunRegistry` 直接作用于进程，不写事件；结局由下次启动的恢复记为 `unavailable`。参照 P5 的同类规则：开关关闭时仍放行只收紧的 `cancel`、`revoke`、`desktop-off`（[P5-headless-host](P5-headless-host.md) §10.1 第 10 条）。
- 解除 fence 只能重启 daemon；重新打开时 SQLite 回滚未完成的事务。
- 打开失败、`integrity_check` 不过、`SQLITE_CORRUPT`、`SQLITE_NOTADB`、`user_version` 高于本构建（data §4.0）：拒绝接收命令，App 显示 unavailable 与原因。**不自动重建。**用户显式「移到一旁并重建」时，旧文件改名保留，新库带新 `logId`；客户端全部重取快照，且不得自动重发 `unknown` 的 intent（protocol §5.2）。
- userData 在网络文件系统上：打开前检测，显示明确的 unavailable 文案（plan §8.3），不尝试打开。

## 2.6 Effect worker 与结果命令

- worker 的结果（Provider 已结束、trace 已归档、记录已写）不直接改表，作为系统命令回到 Orchestrator，保持单写者。
- 结果命令的 id 是确定的：`effect:<effectId>:<step>`（`step` 如 `admitted`、`dispatched`、`provider_settled`、`finalized`）。重复投递得到同一回执，不重复产生事件。
- `run.admitted` 是 effect 的结果，不是决策。准入的权威仍在 `RunRegistry` 与闸门（`admitRun`，`context-admission.ts:77`）。
- **副作用已完成、结果未提交就崩溃**：重启恢复先查 recorder 提交日志与归档（`runStartupRecovery`，`bootstrap/startup-recovery.ts:18-76`，由 `host-process.ts:218-226` 等待）。能证明的提交 `run.provider_settled` / `run.finalized`，证据引用与质量标记原样；不能证明的记 `unavailable`。

## 2.7 一个 run 一个 id

- 今天 canonical run id 有三种形式（`daemon-run-evidence.ts:19-22`）：daemon 自己派发的（设备或 App）是 `remote-run-…`；本机直接启动的是 `run-…`；会话 run 沿用 turn 的 UUID。
- 设备 run 另有台账 id（UUID），靠 `bound` 标记对上（`daemon-run-evidence.ts:15-30`）；App 启动后最多等 3 s 绑定（`daemon-run-runtime.ts:28`）。
- P4 在决策时分配 canonical id，写进 `run.intent_recorded`，派发沿用。实现前确认运行管线接受预分配 id（会话 run 已证明可以）。
- 旧台账要求 run id 与 intent id 都是 UUID（`session-ledger.ts:84`、`:292-293`）。所以旧台账镜像（plan §9）需要映射表 `orch_legacy_run(ledger_run_id PK, run_id)`；设备 intent 的台账 id 作为别名保留到 P4-6。

## 2.8 两本账的边界（决定 G）

P4-2 起 `conversations/<id>.json` 与日志并存。各管一部分：

| 内容 | 权威 | 另一方 |
|---|---|---|
| turn 成员、顺序（ordinal）、`bindingId` | 会话文件（`conversation-turns.ts:178-181` 写 `ordinal: turns.length + 1`） | `turn.began` 引用它 |
| 原生会话绑定 `nativeSessionId` | 会话文件：续接覆盖检查在存储准入下读它（`conversation-turns.ts:229-245`） | `run.session_bound` 只是事实记录；两边不一致时以文件为准，拒绝续接并记 `conversation_binding_conflict` |
| run 生命周期、投递状态、结局 | 事件 | 文件里的 `delivery` 由可重放 effect `conversation.writeback` 回写 |

- 写入顺序：发送时先 persist 文件（turn `pending`），再提交 §2.4 的事务；结算时先提交事件，再回写文件。
- 启动对账（在恢复事务内）：文件里有 turn、却没有 `turn.began` → 那次提交没有完成，Provider 从未调用，turn 记 `not_sent`（今天是 `unknown`，`conversation-turns.ts:298-303`）。事件已有结论、文件仍 `pending` → 重新排队回写。

## 2.9 单写者与外部变化

**单写者**，三层：daemon 锁（`src/daemon/ledger-lock.ts:5-9`，注释写明它是台账唯一的写者闸门）；连接设 `locking_mode=EXCLUSIVE`；静态检查 main 不导入 `src/host-runtime/orchestration/`（写法同 `src/daemon/daemon-imports.test.ts`）。

**不是 daemon 引起的变化**：终端里直接运行的原生 CLI 会话、外部写入的 transcript。今天靠 `liveRuns` 每 1 s 的 tick 重读历史版本发现（`host-controller-watch.ts:21`、`:136`、`:141`）。P4 中 `catalog.scan` 的触发：

| 触发 | 范围 |
|---|---|
| 客户端订阅 `sessions` 且不带 `known`，或重连 | 全部已知 Provider 的会话根，一次 |
| 有 `sessions` 订阅者时 | 同上，每 30 s 一次低频兜底 |
| 打开一个会话的 `detail` | 该会话的 transcript，一次 |
| 有 `detail` 订阅者、且该会话没有 daemon 自己的活跃 run | 该 transcript 每 2 s `stat` 一次（大小、mtime），变化才读 |

扫描结果作为 `session.discovered` 等命令进 Orchestrator。没有订阅者时不扫描。

## 2.10 多 Agent 层的预留（维护者 2026-11-18；P6 评审后修订 2026-11-19）

P6（[P6-multi-agent-draft](P6-multi-agent-draft.md)，草案）让 Provider 里的 Agent 经 Scry 自有的编排 MCP 委派子任务。那是核心之上的另一层。下表的列、字段与规则现在进 P4-0 的初始表结构与决策器，**预留，P4 不实现行为**：P4 中取固定值或为空，没有新命令、新 op、新界面。行号以 `53117a8f` 为准（与 `306e194d` 之间 `src/` 无改动）。

为什么现在留：projection 在裁剪后是权威（data §4.4），30 天前的事实无法从日志回填；回执永久保留，actor 进了回执就不能再改含义。以后再加，要么做数据迁移且回填不全，要么两套语义并存。

**2026-11-19 修订**（P6 独立评审之后，维护者裁定，见 [P6-multi-agent-decisions](P6-multi-agent-decisions.md) §9.1）：R2 只保留 `agent:` 前缀与三列，后缀格式交给 P6；R4 加三行；R5 加会话级停止，级联改按子 run 的 `parent_run_id`；**R6 删除**；R7 的哈希输入待 P6 定；R11 写明服务形态；新增 R12。P4–P6 不改 scry 命令行、其命令与记录格式。

| # | 钩子 | 预留内容 | P4 中的取值 |
|---|---|---|---|
| R1 | 会话谱系 | `orch_p_session` 加 `parent_session_key`、`root_session_key`、`lineage`（`{ kind, source, taskId? }`）、`created_by`（actor）。`kind` 沿用现有名称：`fork`（原生分叉，`Conversation.fork`，`shared/conversation.ts:175-187`）、`side_chat`（侧边会话，`SideChatOrigin`，`:101-110`）；新增 `delegated`（委派任务）。`source` 是来源点 `{ sessionKey, runId?, throughOrdinal? }`，对应 fork 的 `sourceRunId` 与侧聊快照的 `throughRunId`/`throughOrdinal`（`:60-61`） | `fork`、`side_chat` 在 `session.forked`、侧聊的 `session.created` 与导入时照抄会话文件已有字段；`delegated` 不产生。跨 Provider 接续发生在同一会话内（会话绑定 + 历史输入），不是会话谱系 |
| R2 | 发起者 | actor 加一种前缀 `agent:`（经编排 MCP 调用的 Agent），后缀格式由 P6 定。`orch_command`、`orch_event` 加 `principal`（代表哪个用户 grant：用户命令等于 actor，Agent 命令取调用方 run 的 principal）、`via`（Agent 凭据的随机 id，从不是凭据本身）、`actor_run_id`（调用方 run） | 只有 `peer:`、`system`、`effect:`；`principal` = actor；其余为空 |
| R3 | 作者与回答者 | `turn.began` 与 `orch_p_turn` 加 `author`：`user` / `agent` / `system` / `unavailable`；`orch_p_interaction` 加 `answered_by`（actor）。界面只把 `peer:` 显示为「用户发送」「用户批准」；`agent:`、`system` 从不显示为用户批准（AGENTS §3，同 recorder 的 `source: auto`） | daemon 派发的 turn 为 `user`；外部发现的为 `unavailable`（GLOSSARY「轮次」）；`answered_by` 为答复的 peer |
| R4 | 派发前复核 | §2.3 的「提交者的 grant」改读 `principal`。另留六行，只对 `agent:` 命令生效：调用方 run 未终态；调用方 run 没有 `stop_requested`（已请求停止即视为不活跃，决策时同样检查）；凭据未撤销；权限上限仍成立；项目的委派开关仍开；仓库配置指纹等于同一 Provider、同一 canonical cwd 上最近一次用户发起的 run 授权的指纹（没有或不同即 `trust_gate_rejected`，fail closed；只收紧 Agent 发起的 run，用户 run 的自动授权不变） | `principal` = actor，行为不变；六行不触发 |
| R5 | 级联停止 | `orch_p_run` 加 `parent_run_id`（索引）；`run.stop_requested` 加可选 `cascadeRoot`。停止一个 run 时，决策器在同一事务里给所有 `parent_run_id` 等于它的未终态 run 记 `run.stop_requested`，各一行进程绑定的 `provider.run.stop`。按子 run 行查，不读父 run 行：终态行只保留 24 h（data §4.4）。预留会话级命令「停止全部子任务」，只接受 `peer:`。`RunRegistryState`（`run-registry.ts:1-7`）加内存字段 `parentRunId`，存储 fence 时（§2.5）停止仍能沿内存关系级联 | 后代集合为空；会话级命令不产生 |
| R6 | （已删除，2026-11-19） | 首稿的 `orch_p_run.waiting_on` 不再预留。「等待 N 个子任务」由 P6 的任务 projection 按父会话推导，不进 run 行 | — |
| R7 | 幂等命名空间 | `agent:` 命令的 `command_id` 是确定的哈希排成 UUID（形状同 `scopedIntentId`，`remote-gateway.ts:119-122`）；联合主键 `(command_id, actor)` 不变。哈希的输入由 P6 定（草案：含 `actor_run_id`，且委派必须带 `clientRequestId`）。只读工具不是命令，不写回执 | 无 `agent:` 命令 |
| R8 | 重启 | `agent:` 发起、仍在 `pending` 的 outbox 行：重启时一律 `run.cancelled(caller_run_gone)`，不看 TTL。调用方进程随重启消失、其 run 记 `unavailable(host_restarted)`，委派的权威已不在。只比决定 B 更严 | 不触发 |
| R9 | 事件类型与客户端 | 保留 `task.requested`、`task.child_bound`、`task.settled`、`task.cancel_requested`，白名单测试断言 P4 不产生。`subscribe` 请求预留可选的 `eventSet`，宿主只发该集合内的类型（缺省为 1，即第一批）；P4-5a 的客户端解码器忽略不认识的**可选字段**，只有不认识的**类型**才按 protocol §5.2 重置 | 不产生 |
| R10 | 证据引用 | 保留 `task-result:<taskId>`，解析为子 run `run.finalized` 的引用；不复制用量（data §3.3）。事件裁剪后解析为 `unavailable` 并写原因 | 不产生 |
| R11 | 写者位置 | 编排 MCP 服务只在 daemon 进程内（P6：Claude、Qoder 为 SDK 进程内服务，Codex 为 loopback 端点），命令经 Orchestrator（§2.9）；`off` 与进程内路径不提供多 Agent | 无服务 |
| R12 | Agent 发起的 run | `orch_p_run.origin` 预留取值 `'agent'`，加索引 `(origin, lifecycle)`，供 P6 计宿主上 Agent 发起的未终态 run（用户 run 不计入） | 不产生 `'agent'` |

参照 t3code `entity-ids-and-correlation.md`（App id 为主，原生 id 按作用域关联）、`feature-lifecycles.md`（Stop 停止全部委派任务）与 `orchestrator-mcp-server.md`（`clientRequestId` 按作用域、`createdBy` 与 `creationSource` 分开）。不同处：t3 的级联在提交后由 effect 深度优先发出，因为命令只持有本线程的锁；这里决策器单线程，同一事务即可。

**与已定事项的核对。** 回执永久（决定 C）：只加列，只读工具不写回执。单写者（§2.9）：R11。schema 版本与 projection 权威（决定 11、14）：列进 P4-0 的初始版本，不是迁移；事件字段都是可选的，符合只增不改。协议（决定 F）：不加 op、不升版本；R9 的过滤只在宿主；执行目标转发按键精确校验（`execution-targets.ts:48-51`），跨机委派以后另加能力，不占 v3。决定 B：R8 只收紧。Recorder Core 与 scry 命令行：不动。工期约 +1 天（列、索引、可选字段、空级联、不触发的复核行、解码容忍测试）；2026-11-19 的修订删一列、加一个索引与三行复核，仍在约 +1 天之内，在 11–13 周之内，不改总估（plan §9）。
