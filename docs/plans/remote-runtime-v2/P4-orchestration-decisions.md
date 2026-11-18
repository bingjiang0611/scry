# P4 · §11 决定 · §12 评审核对与矛盾 · §13 术语

属于 [P4 设计](P4-orchestration-design.md)。2026-11-18 从 [P4-orchestration-plan](P4-orchestration-plan.md) 拆出：独立评审之后，维护者同日裁定，首稿的「需要维护者决定」全部转为已决定。

## 11. 决定

### 11.1 已决定（维护者 2026-11-18）

维护者的明确裁定是 H、F、B、7 四条与 A 的库位置；其余「按评审建议」。

| # | 决定 | 结论 | 落地 |
|---|---|---|---|
| H | 范围与工期 | 做完整设计，不收缩为评审建议的 5 周切片；约 12 周（11–13），不含 S3 | plan §9 |
| A | 库 | 单独文件 `orchestration.db`；打开、提交失败都 fail closed。PLAN「已定」（2026-11-03 放进现有 App SQLite）同步记了变更 | data §4.0、core §2.5 |
| B | 重启后的已记录未派发 run | 立即路径 intent 与领取同一事务；排队 pending 有 TTL（暂定 60 s），过期作废为可证明的 `not_sent`；派发前复核 grant、工作区授权、操作闸门、trust gate。理由：P5 的登录时启动与无人值守重启可能派发几小时前的提示，且可能带 `full_access` | core §2.3、§2.4 |
| C | 保留 | 事件 30 天；回执与 `resolveIntent` 墓碑永久（约 200 B/条）；outbox `done` 72 h、`voided`/`failed` 30 天；正文在终态后删除 | data §4.3、§4.7、§4.8 |
| D | S3 的位置 | S3 只需先于删除 `off` 路径（P4-5b、P4-6）。P4-0 到 P4-4 可与 S3 并行，条件：off↔on 增量导入、daemon 模式 CI 作业 | plan §7 |
| E | 旧会话 | 导入元数据，不导入 turn 正文；增量导入；新 turn 的序号标 `since_import`。PLAN「已定」（P4 只对新会话生效）同步记了变更 | plan §9、data §3.2 |
| F | 协议 | P4-5a 以 v2 能力 `subscribe: 1` 上线并真机验证；P4-5b 一次升 v3，只删旧 op。这是对 PLAN 不变量 7 的明确裁定：并存在升 v3 时结束 | protocol §5.7 |
| G | 两本账的范围 | P4-2 只合并 run 与 turn 投递生命周期；turn 成员、顺序、原生绑定、删除、分支仍归 `ConversationStore`；权威划分与启动对账见 core | core §2.8 |
| 1 | 回执保留（B1） | 永久；只裁剪事件 | data §4.3 |
| 2 | `resolveIntent`（B2） | 是写命令，产生持久的拒绝墓碑回执，挡住迟到的原提交 | data §4.3 |
| 3 | 正文的存放与清除（B3） | ≤16 KiB 内联 outbox，更大的放内容寻址文件；准备阶段同步写；终态后删；删会话时同事务清除并擦除事件预览 | data §4.7 |
| 4 | off↔on（B4） | 每次启动按 `legacy_ledger_seq` 幂等增量导入；不做单向切换 | plan §9 |
| 5 | 订阅回答的 seq 与上限（B5） | 回答扫描位置；事件回答上限 = 快照阈值（128 条 / 256 KB）；有界扫描 | protocol §5.2 |
| 6 | 损坏、满盘、fsync 失败 | fence，fail closed；停止与取消仍放行；不自动重建，用户显式「移到一旁并重建」 | core §2.5 |
| 7 | macOS `fullfsync` | 先测量，按规则决定 | plan §8.3 |
| 8 | 外部变化的触发 | `catalog.scan`：订阅时、30 s 兜底、打开会话、打开会话时每 2 s `stat` | core §2.9 |
| 9 | 执行目标转发 | `subscribe` 进转发白名单；cursor 带 `hostId`；v3 三方同批 | protocol §5.7 |
| 10 | 拒绝分类 | 黏性写回执；可重试不写 | core §2.2 |
| 11 | projection | 裁剪后仍是权威；`projection_schema_version`；形状变化是数据迁移 | data §4.4 |
| 12 | 重启中断的结局 | `unavailable(host_restarted)`，不是 `failed`；`settled_at` 留空 | core §2.4、data §3.2 |
| 13 | Linux 测量范围与 NFS | ext4 与 btrfs；网络文件系统显示明确的 unavailable 文案 | plan §8.3 |
| 14 | 事件 schema | 保留中的事件必须可解码：只增不改 | data §4.2 |
| 15 | 性能门禁 | 首 token 前提交合计 P95 ≤ 8 ms，并记录次数；每段重测 | plan §8 |
| 16 | 多 Agent 预留（维护者 2026-11-18 明确裁定） | P4 只预留会话谱系、发起者与代表的用户、作者与回答者、级联停止、等待子任务、Agent 幂等命名空间、重启作废、保留类型名与解码容忍，不实现行为；多 Agent 另写草案；工期约 +1 天，不改总估 | core §2.10、[P6-multi-agent-draft](P6-multi-agent-draft.md) |

旧合同 §11 的 6 条：1（`SessionLedger` 演进还是新建）→ 新建 Orchestrator + EventSink，复用转移表与重复检测，`LedgerStore` 只覆盖追加、容纳不了同一事务里的 projection 与 outbox；2（进度粒度）→ 只记生命周期（data §4.6）；3（库）→ A；4（客户端 outbox）→ protocol §6；5（catalog）→ protocol §5.4；6（策略表）→ data §4.5。

### 11.2 需要维护者决定

无。

一项等数据：macOS `fullfsync` 按 plan §8.3 的规则定。若测量落到「关」的分支，持久性弱于今天的 H1，届时把数据报给维护者确认。TTL 60 s 与 `run_admission_timeout` 的 20 s 一样是暂定值，随数据调整，不另立决定。

## 12. 评审核对与矛盾

### 12.1 评审意见中与代码不符或需要限定的

逐条在 `172074a2` 上核对。绝大多数成立；以下两条要限定，照实写入正文：

1. **「`shadow`/`on` 在开发与测试中永远不会运行」说过了。** CI 已有 daemon 模式的 smoke，用真实 Electron 拉起 supervisor 与 daemon（`.github/workflows/ci.yml:374`）。成立的部分是：单元与集成测试走进程内（`daemon-mode-default.ts:6-9`），所以仍加一个 daemon 模式作业（plan §7）。
2. **「`synchronous=FULL` 是相对 `scry.db` 的 NORMAL 的新成本」只对一半。** 相对 `scry.db` 成立（better-sqlite3 默认 WAL 同步为 NORMAL）；相对今天的 run 路径，它取代 H1 每条的 fsync（`session-ledger-file.ts:139`），只有 P4-1 影子写期间是纯叠加（plan §8.2）。

评审给的其他行号都对得上，包括 `remote-gateway.ts:232-245`、`session-ledger.ts:84`、`:86-87`、`:253-281`、`:292-293`、`:300`、`:332`、`db-connection.ts:65`、`db-migrations.ts:41`、`:46`、`command-receipts.ts:11`、`host-process.ts:218-226`、`host-controller-watch.ts:136`、`:141`、`run-output-log.ts:7-9`、`execution-targets.ts:17`、`:78`、`:96-97`、`daemon-run-evidence.ts:19-22`，以及 t3code 的 `ThreadStream.ts:20`、`:23`、`ProjectionMaintenance.ts:256`、README `:166`。

### 12.2 首稿自身的错误（已改）

| 首稿 | 实际 |
|---|---|
| `scopedIntentId`（`remote-gateway.ts:227`） | `:227` 是调用处；定义在 `:117-120` |
| 单条进度 ≤4096 字节（`session-ledger.ts:88`） | `MAX_EVENT_DETAIL` 在 `:87`，按字符计 |
| `intent_payload_conflict`（`session-ledger.ts:298`） | `:300` |
| 一个 run 两套 id | 三种 canonical 形式加台账 UUID（core §2.7）；镜像需要 UUID 映射 |
| `synchronous=FULL` 与 H1 持久性相同 | macOS 上不成立：Node 发 `F_FULLFSYNC`，SQLite 默认不发（plan §8.3） |
| t3code 补发「加 256 KB 字节上限」暗示 t3 没有 | t3 已有 1 MiB 的两个上限（`ThreadStream.ts:20`、`:23`） |
| 回执保留 30 天 | t3 回执不随事件裁剪；本设计改为永久 |
| 回答的 `seq` 是全局 seq | 与每次回答上限一起会跳过事件；改为扫描位置 |
| 「cursor 超前 → 快照」没有说明 | 是对今天 `invalid_cursor`（`session-ledger.ts:332`）的有意改变 |
| 影子写失败的后果未写 | 只让影子 fail open，不影响 run，计数（plan §9） |
| iOS `info.protocol == 1` 归 P4-5 | 已在 `172074a2` 单独修复（protocol §5.7） |
| P5 另写审计文件、P5 之后取 v4 | P5 已定批准方式写进 grant、通知走可协商能力（plan §7、protocol §5.7） |

### 12.3 与 PLAN、旧合同、任务说明的矛盾

1. **库的「可降级」与权威不兼容。** 已由 A 解决；PLAN「已定」记了 2026-11-18 的变更。
2. **B4-S 决定与 main 不一致。** [P3-b4s-plan](P3-b4s-plan.md) 2026-11-12 决定「一步到位、不留逃生开关」；`c35d0191` 默认打开但保留 `SCRY_HOST_DAEMON=0`，开发与测试默认进程内，S3 未做。文档没有记录这次改变。仍成立，P4 按现状设计（plan §9 的 off↔on）。
3. **证据标记是两个维度。** 旧合同把 `partial` 放进 `quality`；代码与 GLOSSARY 中 `status` 与 `quality` 分开（`turn-record-contracts.ts:8-9`）。
4. **lane 数。** PLAN 写 4 条；代码 8 条（`desktop-lane.ts:41`）。
5. **用量的「权威」没有质量标记。** `run-output-log.ts:7-9` 称台账 `result` 标记是 exact 用量权威，但标记没有 `status`/`quality`/来源（`remote-run-binding.ts:196`）。P4-6 改。
6. **iOS 的 info 版本检查。** 已修复（`172074a2`）。
7. **P5 的「批准方式」。** 首稿称 P5 另写审计文件；P5 已定写进 grant 的 `approvedVia`（[P5-headless-host](P5-headless-host.md) §10.1 第 4 条）。已改。
8. **「首屏由快照一次返回」。** 内容不进事件，快照要捎带内容通道的首页；超过 512 KiB 需分块续读（protocol §5.6）。
9. **重启后派发与不变量 4。** 已由 B 解决：已领取的副作用一律作废，只有排队中、未过期、经复核的 pending 派发。
10. **工期。** PLAN 5–6 周；本设计约 12 周，不含 S3。PLAN「已定」记了改估。
11. **旧合同的位置。** 旧合同范围写 `src/main/remote/`、Electron main；现在权威在 daemon，代码仍多在 `src/main/**` 但由 `src/daemon/host-process.ts` 装配。
12. **不变量 7。** v2 能力与旧 op 并存一段时间；维护者已裁定这不是长期兼容层（F）。
13. **「P5」的含义。** PLAN 阶段表的「P5 按测量决定」是 2026-11-03 的编号；现在 P5 指无界面执行端。PLAN 已加注。

## 13. 建议的术语（未改 GLOSSARY）

概念确认后在实现提交里补：**编排事件**（宿主决定的已发生事实，只引用证据）、**命令回执**（同一命令 id 的唯一结果，永久保留）、**墓碑回执**（为挡住迟到提交而写的拒绝回执）、**投影**（由事件维护、供读取的当前状态，裁剪后仍是权威）、**副作用请求**（提交后才执行的外部动作，分进程绑定与可重放）、**派发栅栏**（调用 Provider 前提交的 `run.dispatched`）、**订阅游标**（`hostId` + `logId` + `seq`）、**易失提示**（不进日志、可丢的唤醒）、**正文**（派发输入，不是证据）。
