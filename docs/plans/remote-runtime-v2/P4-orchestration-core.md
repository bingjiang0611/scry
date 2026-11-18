# P4 · §2 核心模型

属于 [P4 设计](P4-orchestration-design.md)。行号说明见总体设计开头。本文是评审后（2026-11-18）新拆出的一节，收进原 §2.1–§2.4 与评审要求补上的规则。

## 2.1 Orchestrator

- 输入：已准备的命令 `{ commandId, actor, scope, type, payload, prepared }`。`actor` 是证书指纹（远程）或本机 grant 指纹。
- `commandId` 按 actor 作用域。设备 intent 沿用 `scopedIntentId`：定义在 `remote-gateway.ts:117-120`（`peer\0intentId` 的哈希排成 UUID 形状），调用处 `:197`、`:227`、`:239`。
- 决策：`decide(command, view) → { events, effects, receipt }`。`view` 是 projection 的只读视图。
- run 状态机取自 `SessionLedger` 的转移表 `NEXT`（`session-ledger.ts:101-107`）与重复检测（`:295-307`），抽成纯函数后原样复用。
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

**立即路径。** 一个事务提交 `run.intent_recorded`、`turn.began`（会话 run）、回执与 outbox 行，outbox 行在同一事务里**已领取**（`state='running'`、`lease_owner`、`claimed_at`）。「已记录、未领取」的窗口基本消失。

**派发栅栏。** 复核通过、`RunRegistry` 准入之后，一个事务提交 `run.admitted` + `run.dispatched`，**然后**才调用 Provider。它取代 `markDispatched`（`remote-dispatcher.ts:68-80`）：持久转移先于执行。首 token 前因此共 2 次提交（plan §8 门禁）。

**排队。** 准入当时拿不到（操作闸门被认证占用、容量满）时，outbox 行留在 `pending`，带 `expires_at = intent 时刻 + TTL`。TTL 暂定 60 s：覆盖一次受托管的重启（launchd `ThrottleInterval` 10 s 加启动恢复），又远低于「几小时前的提示」。测试用 `SCRY_ORCHESTRATION_PENDING_TTL_MS` 调小，不改默认值。

**重启。** 在 `runStartupRecovery` 之后（`host-process.ts:218-226`）、开放 `local.sock` 之前，用一个恢复事务处理：

| 重启前 | 处理 | 结局 |
|---|---|---|
| `pending`，未过期 | 复核（§2.3）后派发一次 | 正常 |
| `pending`，已过期，或时钟回拨（现在早于 intent 时刻） | `run.cancelled(pending_expired)`；会话 run 的 turn 记 `not_sent` | 可证明未发送 |
| `pending` 的会话 run（交接在内存，H6） | `run.cancelled(conversation_start_unavailable)`；turn `not_sent` | 同 [P3-conversation-send](P3-conversation-send.md) |
| 已领取，没有 `run.dispatched` | `effect.voided` + `run.cancelled(host_restarted_before_dispatch)`；turn `not_sent` | Provider 从未被调用，可证明 |
| 已派发，没有终态 | 先查 recorder 证据（§2.6）；能证明就按证据收尾，否则 `run.interrupted`，结局 `unavailable(host_restarted)` | 不是 `failed` |
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
