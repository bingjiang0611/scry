# P4 · §3 证据合同 · §4 表结构与事件

属于 [P4 设计](P4-orchestration-design.md)。行号以 `72c83932` 为准。

## 3. 证据合同

### 3.1 事件引用证据，不复制证据

每个事件可带 `evidence`：一个引用数组。引用只指向**提交时已经落盘**的字节；稍后才写出的内容（例如收尾时才写的 trace 归档）由稍后的事件引用，绝不提前指向。

| 引用 | 形式 | 来源与校验 |
|---|---|---|
| recorder 记录 | `scry-record:<workspaceId>/<recordId>#sha256=<hex>` | 托管提交日志里的 `recordId`（`managed-turn-commit.ts:58`、`:105-106`，`archive_committed` 之后才有）；按 id 读一个文件（`store-index.ts:129-132`） |
| trace 归档 | `trace-archive:<provider>/<cwdKey>/<sessionStem>/<turn>#sha256=<hex>` | `transcript-archive.ts:385` 的每轮目录 |
| 原生 transcript | `transcript:<provider>:<nativeSessionId>#bytes=<end>,sha256=<hex of [0,end)>` | 只用于有文件的 Provider（Claude、Pi 的 JSONL）；没有文件的写 `unavailable` + 原因 |
| Provider 结果 | `provider-result:<runId>` → 解析为 trace 归档中 `harness/result` 项的位置 | 不单独存一份 |
| run 输出区间 | `run-output:<runId>#seq=<from>-<to>` | H10；只是内容，**不是**用量证据（`run-output-log.ts:5-9`） |
| 旧台账 | `legacy-ledger:<seq>` | 导入时（§9），只读一次 |
| 旧目录 | `app-sessions:<sha256 of file>` | 导入时 |

### 3.2 两个标记，原样携带

代码与 GLOSSARY 是两个独立维度，旧合同把它们混成了一列：

- `status`：`available` / `partial` / `disabled` / `unavailable`（`turn-record-contracts.ts:9`）；
- `quality`：`exact` / `estimated` / `inferred` / `unavailable`（`turn-record-contracts.ts:8`）。

规则：

1. 事件里任何「结论」字段都是 `Evidence<T>` 形状（`turn-record-contracts.ts:11-17`）：`{ status, quality, source[], value?, omissionReason? }`。从 recorder 记录或 trace 来的值，两个标记原样复制，不升不降。
2. 缺证据写 `status: 'unavailable'` + `omissionReason`，`value` 省略。投影列可空，空不是 0；排序与汇总遇到空值显示为未知。
3. 宿主推断出的结论（例如重启后把 `running` 作废）标 `quality: 'inferred'`，`source` 写推断依据（`host_restarted`）。
4. `run-output` 的截断标记（`truncated`）与 `output_capture_failed` 映射为 `status: 'partial'`，不把部分输出当完整。

### 3.3 用量不进事件

`run.provider_settled` 只带 `isError` 与 `provider-result` 引用，**不带** tokens、费用、Credits。用量的权威仍是轮次记录与统计库（H11），事件只引用。理由：今天 H2 的 `result` 标记带数字却没有质量与来源（`remote-run-binding.ts:196`），把它搬进事件就多了一个无标记的用量来源，还可能与统计库重复计数。P4-6 删除该标记里的数字。

### 3.4 Recorder Core 不变

- `src/core/turn-recorder/` 不导入 `better-sqlite3`，也不知道事件日志；现在就成立（`src/core` 下无 sqlite 引用）。P4-0 加一条导入测试守住它，写法同 `src/daemon/daemon-imports.test.ts`。
- 事件日志只读 recorder 的产物（记录文件、提交日志），不改 recorder 的提交流程与 commit callback 的 trust 语义。

## 4. 表结构

库与位置见决定 A。迁移沿用 `migrateDatabase(db, migrations)`（`db-migrations.ts:37-51`）：它按传入的列表逐版本建事务，可以给编排库单独一份列表。WAL；`synchronous = FULL`（与 H1 每条 fsync 的持久性相同）；`foreign_keys = ON`。

### 4.1 `orch_meta`

`key TEXT PK, value TEXT`：`log_id`（建库时随机 UUID，客户端 cursor 的命名空间）、`pruned_through`（已删除事件的最高 seq）、`imported_from_legacy`（导入完成标记）。

### 4.2 `orch_event`（只追加）

| 列 | 说明 |
|---|---|
| `seq INTEGER PRIMARY KEY AUTOINCREMENT` | 全局序号，跨 daemon 重启单调 |
| `event_id TEXT UNIQUE` | |
| `at INTEGER` | 注入时钟的毫秒 |
| `type TEXT` | 白名单（§4.5） |
| `stream TEXT` | `session:<key>`、`run:<runId>`、`host` |
| `session_key`、`run_id` | 可空，便于按流读 |
| `command_id TEXT` | 可空；系统事件为空 |
| `actor TEXT` | `peer:<certSHA256>`、`system`、`effect:<effectId>` |
| `scope TEXT` | `local` / `remote` / `system`；决定远程订阅能否看到（§5.5） |
| `payload TEXT` | 规范 JSON（键排序），≤ 16 KiB；超过即拒绝，正文必须走内容通道 |
| `evidence TEXT` | 可空，§3.1 的引用数组 |

索引：`(stream, seq)`、`(run_id, seq)`、`(session_key, seq)`、`(command_id)`。

### 4.3 `orch_command`（回执）

`command_id TEXT`、`actor TEXT`，联合主键；`type`、`payload_sha256`、`accepted_at`、`status`（`accepted` / `rejected`）、`reason`、`result_seq`（接受时最后一个事件的 seq）。

- 同 id、同摘要：返回同一回执，不重新决策，不产生副作用。
- 同 id、不同摘要：`command_payload_conflict`，沿用 H1 的 `intent_payload_conflict` 规则（`session-ledger.ts:298`）。
- 旧设备 intent 的 `intentId` 直接作为 `command_id`，所以 `resolveIntent` 变成查回执，语义不变。

### 4.4 Projection（与事件同一事务更新）

| 表 | 主键 | 主要列 | 取代 |
|---|---|---|---|
| `orch_p_session` | `session_key` | `conversation_id?`、provider、profile、canonical cwd、title、`ts`、pinned/archived、`last_run_id`、`last_run_outcome`（`Evidence` JSON，缺即未知）、`active_run_id`、`pending_questions`、`legacy`、`rev_seq` | H4 的读取、`listSessions` 现算（`host-runtime.ts:170-200`） |
| `orch_p_turn` | `(session_key, ordinal)`；`run_id` 唯一 | `user_text_preview`（≤512 字符）、`delivery`、`outcome`、`started_at`、`settled_at`、`content_ref`（trace 归档引用）、`evidence`、`rev_seq` | H3 的 turn 列表、renderer 合并（C4） |
| `orch_p_run` | `run_id` | session_key、owner actor、scope、origin、provider、profile、cwd、`prompt_preview`（≤200 字符，同 `host-controller-watch.ts:22`）、lifecycle、stop state、`output_seq`、`intent_seq`、`rev_seq` | H8 的离场状态、H12 的 `liveRuns` 组装；终态行保留 24 h |
| `orch_p_interaction` | `(run_id, question_id)` | kind、source、state、`answer_id`、`answer_sha256`、opened/closed seq | H7 的 512 条内存去重 |

索引：`orch_p_session(archived_at, ts DESC, session_key)` 支撑分页；`orch_p_run(lifecycle)`。

过渡期（P4-4 到 S3 第 10 步之间），`orch_p_session` 的变化由 effect 回写 `app-sessions.json`，供仍直接读文件的地方使用（[b4-s0-final](status/b4-s0-final.md)「后续」第 3 条：App 仍直接读会话存储）。回写是视图，不是第二个权威。

### 4.5 `orch_outbox`

`effect_id PK`、`kind`、`policy`（来自集中策略表，写入时固定）、`run_id`、`causation_seq`、`payload`、`state`（`pending` / `running` / `done` / `failed` / `voided`）、`attempts`、`lease_owner`（daemon 实例身份，同 `remote-lease-owner.ts`）、`claimed_at`、`completed_at`、`result_seq`、`last_error`。索引 `(state, effect_id)`。

| kind | 策略 | 重启时 |
|---|---|---|
| `provider.run.start` | 进程绑定 | `running` → `voided`；`pending` 见决定 B |
| `provider.run.stop`、`question.respond` | 进程绑定 | 一律 `voided`（进程已不在） |
| `catalog.writeback`（§4.4 回写） | 可重放 | 重新排队 |
| `catalog.scan`（发现外部会话） | 可重放 | 重新排队 |

策略表集中在一个模块，测试断言每个 `kind` 都已登记（REVIEW-BATCH1 的建议，旧决定 6 不再待决）。会话删除、分支已有自己的持久化两阶段状态（`conversation-lifecycle` 的 `beginDeletion`/`finishFork`），第一批不进 outbox。

### 4.6 第一批事件类型

| 流 | 类型 |
|---|---|
| run | `run.intent_recorded`（含预分配 canonical id）、`run.admitted`、`run.dispatched`（领取）、`run.session_bound`、`run.stop_requested`、`run.question_opened`、`run.question_answered`、`run.question_closed`、`run.provider_settled`、`run.finalized`（trace 归档、记录引用）、`run.settled` / `run.failed` / `run.cancelled`（终态，`failed` 带原因：`host_restarted`、`effect_voided`、`conversation_start_unavailable`、`trust_gate_rejected`、`run_admission_timeout`） |
| run（内容缺口） | `run.content_gap`（`output_capture_failed`、`history_capture_failed` → `status: partial`） |
| session | `session.created`、`.renamed`、`.pinned`、`.unpinned`、`.archived`、`.restored`、`.deleted`、`.forked`、`.discovered`（外部会话，引用 transcript）、`.imported`（迁移） |
| turn | `turn.began`、`turn.delivery`（`accepted` / `not_sent` / `unknown`，同 `shared/conversation.ts:113-117`） |
| effect / host | `effect.voided`、`host.started`（daemon 实例身份；客户端据此知道发生过重启） |

不在第一批：设备与配对、未读集合、终端、MCP。新增类型要同时改白名单、projection 与测试；客户端遇到不认识的类型按协议错误处理并重取快照，不静默跳过。

`run.progress` 的粒度（旧决定 2）：**只记生命周期转折**，不记文本增量。输出前进只发易失提示（§5.3）；`run.finalized` 一次性带上输出高水位与归档引用。按 S1 的 paced 场景（20 段），一轮约 8–12 个事件（run 7–9 个、turn 2 个、会话行变化 1 个），与今天 H1 一轮的条数（intent、dispatched、admitted、bound、started、session、result、settled）相当。

### 4.7 压缩与保留

- projection 表就是快照，不另存快照文件。H1 的「快照 + 保留尾部」机制（`session-ledger.ts:242-268`）不再需要。
- 保留期（决定 C，建议 30 天）：删除早于保留期、且 seq ≤ 所有 projection 已应用位置的事件；每个流保留最新一条。`pruned_through` 同事务更新。
- 回执 `orch_command` 保留 30 天；客户端 outbox 的重试窗口必须短于它；C1、C2 目前的重试上限未核对，P4-5 核对并在需要时加上。
- outbox：`done` 72 h 后删，`voided`/`failed` 30 天。
- 原始证据（transcript、trace 归档、记录、Provider result）不受影响，仍长期保留。
