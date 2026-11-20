# P4 · §3 证据合同 · §4 库、表与事件

属于 [P4 设计](P4-orchestration-design.md)。行号说明见总体设计开头。2026-11-18 评审后修订：transcript 引用改为增量区间、补上导入与重启的质量规则、回执永久保留、正文存储与清除、迁移执行器、projection schema 版本。

## 3. 证据合同

### 3.1 事件引用证据，不复制证据

每个事件可带 `evidence`：一个引用数组。引用只指向**提交时已经落盘**的字节；稍后才写出的内容（例如收尾时才写的 trace 归档）由稍后的事件引用，绝不提前指向。

| 引用 | 形式 | 来源与校验 |
|---|---|---|
| recorder 记录 | `scry-record:<workspaceId>/<recordId>#sha256=<hex>` | 托管提交日志里的 `recordId`（`managed-turn-commit.ts:58`、`:105-106`，`archive_committed` 之后才有）；按 id 读一个文件（`store-index.ts:129-132`） |
| trace 归档 | `trace-archive:<provider>/<cwdKey>/<sessionStem>/<turn>#sha256=<hex>` | `transcript-archive.ts:385` 的每轮目录 |
| 原生 transcript | `transcript:<provider>:<nativeSessionId>#bytes=<start>-<end>,sha256=<hex of [start,end)>` | 每轮只哈希本轮新增的区间，不再每次从 0 哈希整份文件。只用于有文件的 Provider（Claude、Pi 的 JSONL）；没有文件的写 `unavailable` + 原因 |
| Provider 结果 | `provider-result:<runId>` → 解析为 trace 归档中 `harness/result` 项的位置 | 不单独存一份 |
| run 输出区间 | `run-output:<runId>#seq=<from>-<to>` | H10；只是内容，**不是**用量证据 |
| 旧台账 | `legacy-ledger:<seq>` | 导入时（plan §9） |
| 旧目录 | `app-sessions:<sha256 of file>` | 导入时 |

**解析不到时。** Provider 删除或轮转了 transcript、文件短于 `end`：解析为 `unavailable`，`omissionReason: source_removed`。区间哈希不符：`source_changed`。两者都不是错误，也不回退成「最新内容」。

### 3.2 两个标记，原样携带

代码与 GLOSSARY 是两个独立维度，旧合同把它们混成了一列：

- `status`：`available` / `partial` / `disabled` / `unavailable`（`turn-record-contracts.ts:9`）；
- `quality`：`exact` / `estimated` / `inferred` / `unavailable`（`turn-record-contracts.ts:8`）。

规则：

1. 事件里任何「结论」字段都是 `Evidence<T>` 形状（`turn-record-contracts.ts:11-17`）：`{ status, quality, source[], value?, omissionReason? }`。从 recorder 记录或 trace 来的值，两个标记原样复制，不升不降。
2. 缺证据写 `status: 'unavailable'` + `omissionReason`，`value` 省略。投影列可空，空不是 0；排序与汇总遇到空值显示为未知。
3. 宿主推断出的结论标 `quality: 'inferred'`，`source` 写推断依据。
4. `run-output` 的截断标记（`truncated`）与 `output_capture_failed` 映射为 `status: 'partial'`，不把部分输出当完整。
5. **重启中断的 run**（core §2.4）：结局 `unavailable(host_restarted)`；`settled_at` 留空，因为没有真实的结束时刻。另记 `recovered_at`：恢复运行的宿主时刻，只表示「何时发现」，不当作结束时间显示。
6. **导入的结局**：`app-sessions.json` 的 `lastRunOutcome` 导入为 `quality: 'inferred'`（`source: app-sessions:<hash>`），读不出时 `unavailable`；**从不**是 `exact`。
7. **导入会话的轮次**：不导入 turn 正文，所以导入会话里新 turn 的 `ordinal` 从导入时数起。行带 `ordinal_origin: 'native' | 'since_import'`；后者不得显示为「第 N 轮」。
8. **远程的会话总数**：`sessions.total` 是本 grant 可见行的数目；算不出就 `unavailable`。从不给未过滤的总数，也不把估计值当 exact 显示。今天同样按已授权列表计数（`remote-gateway-session-list.ts:76`、`:82`）。
9. **首屏快照不带用量**：客户端显示加载中或 `unavailable`，不显示 0。

### 3.3 用量不进事件

`run.provider_settled` 只带 `isError` 与 `provider-result` 引用，**不带** tokens、费用、Credits。用量的权威仍是轮次记录与统计库（H11），事件只引用。理由：今天 H2 的 `result` 标记带数字却没有质量与来源（`remote-run-binding.ts:196`），搬进事件就多了一个无标记的用量来源，还可能与统计库重复计数。P4-6 删除该标记里的数字，并改正 `run-output-log.ts:7-9` 的注释（它称该标记是 exact 用量的权威）。

### 3.4 Recorder Core 不变

- `src/core/turn-recorder/` 不导入 `better-sqlite3`，也不知道事件日志；现在就成立。P4-0 加一条导入测试守住它，写法同 `src/daemon/daemon-imports.test.ts`。
- 事件日志只读 recorder 的产物（记录文件、提交日志），不改 recorder 的提交流程与 commit callback 的 trust 语义。

## 4. 库、表与事件

### 4.0 库、连接与迁移（决定 A）

- 文件：`userData/orchestration/orchestration.db`，文件 0600、目录 0700。
- 连接：WAL；`synchronous=FULL`；`locking_mode=EXCLUSIVE`（core §2.9）；`foreign_keys=ON`；`secure_delete=ON`（同 `scry.db`，`db-connection.ts:49`）；macOS P4-2 默认 `fullfsync=ON`、`checkpoint_fullfsync=ON`（plan §8.3）。
- **NORMAL 窗口（决定 H §14.6）**：延迟历史补导入期间，为让同进程 worker 独立连接后台跑 `wal_checkpoint(PASSIVE)`，主连接短暂切 `locking_mode=NORMAL` + `busy_timeout=500`，结束或取消立即恢复 `EXCLUSIVE`（写 `wal_lock_mode='exclusive'`、`busy_timeout=0`）；窗口内第 1 层 `daemon.lock` 仍独占宿主。
- **不支持的回退路径（决定 H §14.5）**：不支持从 `on` 直接切回进程内模式（`SCRY_HOST_DAEMON=0`）或降级到 P4-2 之前版本；须先用当前 daemon 以 `off` 启动一次。`off`/未设置/`shadow` 启动时先用只读连接（`readonly: true, fileMustExist: true, timeout: 0`）快查 `orch_meta.orchestration_on_active`（0 字节/损坏/未置 `'1'` 时直接返回，不跑 `integrity_check` 也不改写文件）；仅在值为 `'1'` 时完整打开库 fail-open 校正 H1（用 `h1.describe().lastSeq`，结果 `>= R`；因 `on` 模式块预留恒使退出时 `h1LastSeq < R`，`since(0).cursor` 受 256 分页上限约束与 `h1LastSeq < R` 判定在 `on_active='1'` 下行为等价，但代码仍以 `lastSeq` 为准）并清 `'0'`。为兜底 `off` 期间 DB 不可用导致 fail-open 跳过校正的残余，`on` 启动时在 `try/catch` 内取 `max(R, legacy_ledger_seq, H1 lastSeq)`。
- 迁移用**独立执行器**，不复用 `migrateDatabase`（`db-migrations.ts:46` 硬编码 `repairMissingUsageLedger`，且遇更高 `user_version` 静默返回，而权威库必须拒开 `orchestration_schema_newer`，core §2.5）。

### 4.1 `orch_meta`

`key TEXT PK, value TEXT`：

| key | 含义 |
|---|---|
| `log_id` | 建库时随机 UUID，客户端 cursor 的命名空间 |
| `pruned_through` | 已删除事件的最高 seq |
| `projection_schema_version` | projection 形状版本；改形状是数据迁移（§4.4） |
| `legacy_ledger_seq` | 旧台账已反映到日志的最高 seq（导入或镜像，plan §9） |
| `legacy_catalog_sha256` | 上次导入的 `app-sessions.json` 哈希；不同就增量导入 |
| `orchestration_on_active` | `'1'` 表示上次以 `on` 权威运行过；`off`/未设置/`shadow` 仅在该键为 `'1'` 时 fail-open 校正 H1 并清 `'0'`（决定 H §14.4） |
| `h1_seq_reserved_until` | 设备台账编号块预留上限 `R`（1,024/块）；重启与 `off` 校正均 `>= R`，首 token 前不新增提交（决定 H §14.2） |
| `h1_fallback_unavailable` | `'1'` 表示 H1 下游镜像写/重写失败；进程内定期重试快照重写，成功后清 `'0'`，状态从 daemon 状态接口可读（决定 H §14.3） |
| `h1_fallback_reason` | 最近一次 H1 镜像失败原因；重试恢复后清空 |
| `wal_lock_mode` | NORMAL 窗口结束恢复 `EXCLUSIVE` 时写入 `'exclusive'` 强制重获独占锁 |

### 4.2 `orch_event`（只追加）

| 列 | 说明 |
|---|---|
| `seq INTEGER PRIMARY KEY AUTOINCREMENT` | 全局序号，跨 daemon 重启单调 |
| `event_id TEXT UNIQUE` | |
| `at INTEGER` | 注入时钟的毫秒 |
| `type TEXT` | 白名单（§4.6） |
| `stream TEXT` | `session:<key>`、`run:<runId>`、`host` |
| `session_key`、`run_id` | 可空，便于按流读 |
| `cwd TEXT` | 可空；canonical cwd。projection 行删除之后，远程可见性仍能按它判断（protocol §5.5） |
| `command_id TEXT` | 可空；系统事件为空 |
| `actor TEXT` | `peer:<certSHA256>`、`system`、`effect:<effectId>` |
| `scope TEXT` | `local` / `remote` / `system`；决定远程订阅能否看到 |
| `payload TEXT` | 规范 JSON（键排序），≤16 KiB；超过即拒绝。不含正文，只含 ≤200/512 字符的预览与正文哈希 |
| `evidence TEXT` | 可空，§3.1 的引用数组 |

索引：`(stream, seq)`、`(run_id, seq)`、`(session_key, seq)`、`(command_id)`。

预留列（core §2.10 R2，**预留，P4 不实现行为**）：`principal`、`via`、`actor_run_id`；`actor` 另有 `agent:` 前缀一种（后缀格式由 P6 定），P4 不产生。

**事件 schema 兼容是硬约束。** 保留期内的任何事件都要能被当前构建解码：类型只增不改；字段只增可选的；含义变了就用新类型。客户端遇到不认识的类型按 protocol §5.2 处理。

### 4.3 `orch_command`（回执，永久保留）

`command_id TEXT`、`actor TEXT`，联合主键；`type`、`payload_sha256`、`accepted_at`、`status`（`accepted` / `rejected`）、`reason`、`result`（小 JSON，如 run id）、`result_seq`（接受时最后一个事件的 seq）。约 200 B/条。

- 同 id、同摘要：返回同一回执，不重新决策，不产生副作用。
- 同 id、不同摘要：`command_payload_conflict`（黏性，core §2.2），沿用 H1 的规则（`session-ledger.ts:300`）。
- 只有黏性结果写回执；可重试的拒绝不写（core §2.2）。
- 旧设备 intent 的 scoped id 直接作为 `command_id`，`intentStatus` 变成查回执，语义不变。
- **`resolveIntent` 是写命令。** 今天它在找不到时先记录一个没有路由的 intent，再取消它，借此挡住迟到的原提交（`remote-gateway.ts:232-245`）。P4 中它写一张墓碑回执：`type='run.submit'`、`payload_sha256='resolved_absent'`、`status='rejected'`、`reason='resolved_absent'`、`result` 带新生成的 run id。回答仍是 `{ runId, state: 'cancelled' }`；迟到的原提交摘要不同，得到 `command_payload_conflict`。
- 系统结果命令 id 为 `effect:<effectId>:<step>`（core §2.6）。
- 预留列 `principal`、`via`、`actor_run_id` 与 Agent 命令的 id 规则见 core §2.10 R2、R7（**预留，P4 不实现行为**）。
- **保留：永久。** 只裁剪事件，不裁剪回执与墓碑。按每天 100 轮、每轮 2–3 条回执，约 60 KB/天、约 20 MB/年。永久保留让客户端 outbox 的重试窗口不再受限；宿主重建库（新 `logId`）时回执随旧库失效，客户端按 protocol §5.2 处理。

### 4.4 Projection（与事件同一事务更新）

| 表 | 主键 | 主要列 | 取代 |
|---|---|---|---|
| `orch_p_session` | `session_key` | `conversation_id?`、provider、profile、canonical cwd、title、`ts`、pinned/archived、`last_run_id`、`last_run_outcome`（`Evidence` JSON，缺即未知）、`active_run_id`、`pending_questions`、`legacy`、`rev_seq` | H4 的读取、`listSessions` 现算（`host-runtime.ts:170-200`） |
| `orch_p_turn` | `(session_key, ordinal)`；`run_id` 唯一 | `ordinal_origin`、`user_text_preview`（≤512 字符）、`delivery`、`outcome`、`started_at`、`settled_at`、`recovered_at`、`content_ref`、`evidence`、`rev_seq` | H3 的 turn 列表、renderer 合并（C4） |
| `orch_p_run` | `run_id` | session_key、owner actor、scope、origin、provider、profile、cwd、`prompt_preview`（≤200 字符，同 `host-controller-watch.ts:22`）、lifecycle、stop state、`output_seq`、`intent_seq`、`body`（§4.7）、`rev_seq` | H8 的离场状态、H12 的 `liveRuns` 组装；终态行保留 24 h |
| `orch_p_interaction` | `(run_id, question_id)` | kind、source、state、`answer_id`、`answer_sha256`、opened/closed seq | H7 的 512 条内存去重 |

索引：`orch_p_session(archived_at, ts DESC, session_key)` 支撑 keyset 分页（protocol §5.1）；`orch_p_run(lifecycle)`。

预留列（core §2.10，**预留，P4 不实现行为**，进 P4-0 的初始表结构）：`orch_p_session` 的 `parent_session_key`、`root_session_key`、`lineage`、`created_by`（R1；P4 只照抄 fork 与侧聊已有的来源）；`orch_p_turn` 的 `author`（R3）；`orch_p_run` 的 `parent_run_id`（索引，R5）；`orch_p_run.origin` 的预留取值 `'agent'` 与索引 `(origin, lifecycle)`（R12）；`orch_p_interaction` 的 `answered_by`（R3）。首稿的 `waiting_on`（R6）2026-11-19 删除，等待计数由 P6 的任务 projection 推导。

- **projection 是权威。** 事件被裁剪之后，projection 不能也不需要从日志重建。「从空重放等于在线 projection」只在未裁剪窗口内、且排除已清除的会话时检验（plan §10）。
- **形状变化是数据迁移**：随 §4.0 的执行器改写行并提升 `projection_schema_version`，不靠重放。
- 过渡期（P4-4 到删除 `off` 之间），`orch_p_session` 的变化由 effect 回写 `app-sessions.json`，供仍直接读文件的地方使用（[b4-s0-final](status/b4-s0-final.md)「后续」第 3 条）。回写是视图，不是第二个权威。

### 4.5 `orch_outbox`

`effect_id PK`、`kind`、`policy`（来自集中策略表，写入时固定）、`run_id`、`causation_seq`、`payload`（≤16 KiB，可含内联正文，§4.7）、`state`（`pending` / `running` / `done` / `failed` / `voided`）、`expires_at`（只用于 pending）、`attempts`、`lease_owner`（daemon 实例身份，同 `remote-lease-owner.ts`）、`claimed_at`、`completed_at`、`result_seq`、`last_error`。索引 `(state, effect_id)`。

| kind | 策略 | 重启时 |
|---|---|---|
| `provider.run.start` | 进程绑定 | 见 core §2.4 |
| `provider.run.stop`、`question.respond` | 进程绑定 | 一律 `voided`（进程已不在） |
| `catalog.writeback`、`conversation.writeback` | 可重放 | 重新排队 |
| `catalog.scan` | 可重放 | 重新排队；触发见 core §2.9 |
| `legacy.mirror`（**不再是可重放的 outbox effect**） | 进程内纯下游镜像（不进 `orch_outbox`） | 不经 outbox 重放；按决定 H 由 DB 状态重建 |

**从 DB 重建设备台账与 H1 镜像（决定 H §14.1–§14.3）：** `on` 启动时设备台账只由 DB 状态生成单份快照（`lastSeq = minCursor = R`，`retainedEvents = []`，不读 H1、不重编号），旧游标收到 `reset` 后经 `runState`/trace 重同步。首次进入 `on`（0 run 也写）即同步写合法 H1 快照；追加失败不重试同一 `seq`，改用 DB 快照原子重写；重写再失败则记 `h1_fallback_unavailable='1'` 并定期重试至清除，状态由 daemon 状态接口暴露。

策略表集中在一个模块，测试断言每个 `kind` 都已登记（`legacy.mirror` 仅保留枚举兼容）。会话删除、分支走 `conversation-lifecycle` 持久化两阶段状态，不进 outbox。

### 4.6 第一批事件类型

| 流 | 类型 |
|---|---|
| run | `run.intent_recorded`（含预分配 canonical id 与正文哈希）、`run.admitted`、`run.dispatched`（派发栅栏）、`run.session_bound`、`run.stop_requested`、`run.question_opened`、`run.question_answered`、`run.question_closed`、`run.provider_settled`、`run.finalized`（trace 归档、记录引用）；终态 `run.settled` / `run.failed`（`cwd_changed`、`workspace_not_authorized`、`grant_revoked`、`trust_gate_rejected`、`run_admission_timeout`）/ `run.cancelled`（含 `pending_expired`、`host_restarted_before_dispatch`、`conversation_start_unavailable`）/ `run.interrupted`（结局 `unavailable(host_restarted)`） |
| run（内容缺口） | `run.content_gap`（`output_capture_failed`、`history_capture_failed` → `status: partial`） |
| session | `session.created`、`.renamed`、`.pinned`、`.unpinned`、`.archived`、`.restored`、`.deleted`（墓碑，带 canonical cwd）、`.forked`、`.discovered`（外部会话，引用 transcript）、`.imported`（迁移） |
| turn | `turn.began`、`turn.delivery`（`accepted` / `not_sent` / `unknown`，同 `shared/conversation.ts:113-117`） |
| effect / host | `effect.voided`、`host.started`（daemon 实例身份；客户端据此知道发生过重启） |

不在第一批：设备与配对、未读集合、终端、MCP。新增类型要同时改白名单、projection 与测试。

保留名（core §2.10 R9、R10，**预留，P4 不实现行为**）：`task.requested`、`task.child_bound`、`task.settled`、`task.cancel_requested`；证据引用 `task-result:<taskId>`。`run.stop_requested` 的可选 `cascadeRoot`、`turn.began` 的 `author` 是已有类型上的可选字段。

`run.progress` 的粒度：**只记生命周期转折**，不记文本增量。输出前进只发易失提示（protocol §5.3）；`run.finalized` 一次性带上输出高水位与归档引用。按 S1 的 paced 场景（20 段），一轮约 8–12 个事件，与今天 H1 一轮的条数相当。

### 4.7 正文：存放、保留与清除（B3）

今天提示与 iOS 的 base64 附件放在 `intent_recorded.detail` 里，最多约 1.2 MB（`session-ledger.ts:86`），`poll` 返回前剥掉它（`remote-gateway.ts:246-260`）。P4：

| 项 | 决定 |
|---|---|
| 位置 | ≤16 KiB 的正文内联在 `orch_outbox.payload`；更大的写 `userData/orchestration/bodies/<sha256>`（0600），按内容寻址 |
| 首 token 路径 | 同步：大正文的写入、fsync 与目录 fsync 在准备阶段完成，先于事务。今天 H1 也同步 fsync 整条 intent 行（`session-ledger-file.ts:128-139`），不是新的一类成本；大块提交的耗时进 plan §8 |
| 事件 | 只带 `body: { sha256, bytes }`，不带正文 |
| 桌面附件 | 已在 `DesktopAttachmentStore`（按 sha256 分块暂存，24 h 孤儿清理，`desktop-attachments.ts:3-8`）；正文只引用其 id 与哈希，不重复存 |
| 保留 | 正文是派发输入，不是证据。run 终态且 outbox 行离开 `pending`/`running` 后，与 outbox `done` 行同批删除（72 h） |
| 删除会话 | 与 `session.deleted` 同一事务：删除 projection 行与 outbox 正文、把该会话事件 payload 里的预览字段改写为 `{"redacted":true}`；提交后 unlink 正文文件。结果三态同 `scry.db` 的 `deleteSessionData`（`db-connection.ts:65`）：`deleted` / `not_present` / `unavailable` |
| 与「只追加」 | 「只追加」指不改写事实：类型、seq、id、引用不变。删除会话时擦除内容字段是唯一的改写；`secure_delete=ON` 让被擦除的字节不留在空闲页 |

### 4.8 压缩与保留

- projection 表就是快照，不另存快照文件。H1 的「快照 + 保留尾部」机制（`session-ledger.ts:242-268`）不再需要。
- 事件保留 30 天（决定 C）：删除早于保留期、且 seq ≤ 所有 projection 已应用位置的事件；每个流保留最新一条。`pruned_through` 同事务更新。
- 回执与墓碑：永久（§4.3）。
- outbox：`done` 72 h 后删，`voided`/`failed` 30 天。正文见 §4.7。
- 原始证据（transcript、trace 归档、记录、Provider result）不受影响，仍长期保留。
