# P4 · 编排事件日志：总体设计

状态：最终设计（独立评审之后，维护者 2026-11-18 裁定），不含实现。取代 Batch 1 的旧编排事件日志设计：旧稿写于 daemon 之前，把组件放在 `src/main/remote` 与 Electron main。

行号以分支 `claude/scry-performance-optimization-46ngcf` 的 `72c83932` 为准。评审核对在 `172074a2` 上重做：所引源文件在两者之间没有改动，只有 iOS 的 `TransportRunOperations.swift` 改了一行（protocol §5.7）。

## 评审后修订（2026-11-18）

独立评审提出 5 个阻塞项，以及核心模型、证据、协议、顺序、性能、t3code 对照的意见。维护者同日裁定。每条先对照代码核对再写入；评审与首稿各自说错的地方，见 [决定与核对](P4-orchestration-decisions.md) §12。

- **范围**：做完整设计，不收缩为评审建议的 5 周切片。工期改估约 12 周，不含 S3（plan §9）。
- **远程客户端**：`subscribe` 先作为协议 v2 下的可协商能力上线，真机验证后再升一次 v3，只删旧 op（protocol §5.7）。这是维护者对 PLAN 不变量 7 的明确裁定：新旧并存在升 v3 时结束。
- **决定 B 改写**：立即路径上「记录 intent」与「领取」同一事务；排队中的 pending 有 TTL，过期作废为可证明的 `not_sent`；派发前复核 grant、工作区授权、操作闸门与 trust gate（core §2.3、§2.4）。
- **存储**：事件日志放单独的 `orchestration.db`，PLAN「已定」同步记了变更与日期。回执与 `resolveIntent` 墓碑永久保留，只裁剪事件。正文走内容寻址文件，删除会话时清除（data §4.3、§4.7）。
- **off↔on**：每次启动按 `orch_meta` 记下的旧台账位置做幂等增量导入（plan §9）。
- **macOS `fullfsync`**：先测量，再按写定的规则决定（plan §8.3）。
- **多 Agent 预留**（维护者同日；2026-11-19 P6 评审后修订）：谱系、发起者、作者、级联停止、Agent 幂等命名空间、Agent 发起 run 的来源标记等进 P4-0 的初始表结构，P4 不实现行为（core §2.10）；多 Agent 层见 [P6 草案](P6-multi-agent-draft.md)。P4 不改 scry 命令行、其命令与记录格式。
- **其余**按评审建议：提交失败 fail closed 但放行停止；结果命令用确定性 id；拒绝分黏性与可重试；恢复时先查 recorder 证据；projection 在裁剪后仍是权威并带 schema 版本；单写者；迁移函数的两个陷阱；两本账的边界；外部会话的扫描触发；证据、协议与性能细节。逐项见 decisions §11.1。

| 文件 | 内容 |
|---|---|
| 本文 | 修订说明、结论、t3code 对照、目标架构、组件去留 |
| [P4-orchestration-core](P4-orchestration-core.md) | §2 核心模型：决策、拒绝分类、复核、派发与重启、fail closed、run id、两本账边界、单写者、多 Agent 预留 |
| [P4-orchestration-current](P4-orchestration-current.md) | §1 现状映射：今天谁在决定「发生了什么」 |
| [P4-orchestration-data](P4-orchestration-data.md) | §3 证据合同；§4 库、表、事件、回执、正文、保留与清除 |
| [P4-orchestration-protocol](P4-orchestration-protocol.md) | §5 订阅协议；§6 三类客户端的改动与顺序 |
| [P4-orchestration-plan](P4-orchestration-plan.md) | §7 依赖与顺序；§8 性能；§9 迁移、开关与工期；§10 测试 |
| [P4-orchestration-decisions](P4-orchestration-decisions.md) | §11 已决定与待定；§12 评审核对与矛盾；§13 术语 |

## 0. 结论

1. 今天宿主侧 13 处、客户端 4 处各自记录或推导「发生了什么」（§1）。宿主侧有 7 处只在内存：daemon 重启后命令回执、提问去重、会话 run 交接、未读集合、事件流全部丢失，客户端只能整体重读。
2. P4 只把**决定**收进一处：run 生命周期、会话 turn 投递、会话目录元数据、提问/审批生命周期。trace、run 输出、原生 transcript、`.scry/records` 仍是内容通道，事件只引用。
3. 库已经有了：daemon 用 `better-sqlite3@12.11.1`（`src/daemon/host-process.ts:76` → `src/main/db-connection.ts:44`）。编排放单独的 `orchestration.db`，打开或提交失败都 fail closed，只放行停止（core §2.5）；不像 `scry.db` 那样降级为 no-op（`db-connection.ts:55-61`）。
4. 派发：立即路径 intent 与领取同一事务；重启后已领取未派发的作废为 `not_sent`，已派发未结束的结局记 `unavailable`；只有排队中的 pending 在 TTL 内、经复核后派发（core §2.4）。
5. 顺序：S3 只需先于删除 `off` 路径（P4-5b、P4-6）。P4-0 到 P4-4 可与 S3 并行，条件是 off↔on 增量导入已做、CI 有 daemon 模式作业（plan §7）。
6. 协议：本机 App 先切（P4-3），用本机 op。远程在 P4-5a 以 v2 能力 `subscribe: 1` 上线（先例 `providerDiscovery: 2`、`traceDelta: 1`，`shared/desktop-remote.ts:145`、`:157`），真机验证后 P4-5b 升 v3，只删旧 op。
7. 工期约 12 周（11–13），不含 S3。PLAN 原估 5–6 周，首稿 8.5 周，评审 10–12 周加 S3（plan §9）。

## t3code 对照

> 2026-11-23 复核：本表漏掉了持久化核心、ProviderSession、提示词队列、谱系、检查点等差异，完整清单与要做的事见 [V2-alignment](V2-alignment.md)。

参考 `pingdotgg/t3code` `8cf97b5f`（2026-11-18）的 `docs/orchestration-v2/`、`docs/internals/` 与 `apps/server/src/orchestration-v2/`，只读，不拷代码。首稿有两处说错，已改（decisions §12）。

| 概念 | t3code | 本设计 |
|---|---|---|
| 串行决策，不做 I/O | `Orchestrator.ts`（overview「Durable intent and side effects」） | 照搬。Node 单线程 + 同步事务，串行是天然的；异步准备在决策之前（core §2.3） |
| 一个事务提交事件、projection、回执、outbox | `EventSink.ts` | 照搬 |
| 重复命令 id 返回同一回执 | 回执不随事件裁剪：「Receipts stay for idempotency」（`ProjectionMaintenance.ts:256`），只删已导入旧线程的回执（`:186-245`） | 照搬：回执与 `resolveIntent` 墓碑永久保留，约 200 B/条（data §4.3） |
| outbox 的地位 | README:166「Tracked Follow-Up: Durable Effect Outbox」说它不是第一切片的前提，**那句已过时**：代码里已有完整的 `EffectOutboxV2`（`apps/server/src/orchestration-v2/EffectOutbox.ts:269`）与 `EffectWorker`（`EffectWorker.ts`） | 第一批就要：今天 H1 已有派发栅栏（`remote-dispatcher.ts:68-80`），是迁移而不是新增负担 |
| 进程丢失 | `EffectOutbox.ts:142-163`、`reconcileAfterProcessLoss` 连 `pending` 的 `provider-turn.start` 也取消 | 已领取的一律作废，与 t3 一致；只有排队中的 pending 在 TTL 内经复核派发（决定 B） |
| 重连补发 | 缺口 ≤128 事件（`ThreadStream.ts:18`），且编码字节与原始载荷各 ≤1 MiB（`:20`、`:23`），否则快照 | 照搬 128；字节上限 256 KB（同 `app-event-feed.ts:47`，比 t3 严）；每次回答的上限与快照阈值统一（protocol §5.2） |
| 推送前合并 | 50 ms（`ThreadLiveEventCoalescer.ts:18`） | 只用于易失提示，且第一条立即发（前沿触发）；持久事件不合并 |
| 事件保留 | 约 1 天（`ProjectionMaintenance.ts:42`）；projection 不能从日志重建 | 30 天；裁剪后 projection 仍是权威，重放一致只在未裁剪窗口内检验（决定 C） |
| 保留中的事件可解码 | 只留 1 天，旧形状很快消失；文档未把它列为约束 | **硬约束**：保留 30 天，任何保留中的事件都要能被当前构建解码；事件 schema 只加不改（data §4.2） |
| 原始 Provider 帧 | 可轮转诊断日志（README「Conceptual Layers」） | **不同**：PLAN 明确不做；原始证据长期保留，事件只引用（§3） |
| 命令输出 | 不进事件（`CommandOutputHub.ts`） | 同理：run 输出与 trace 走内容通道 |
| 推送通道 | WebSocket（`ws.ts`） | **不同**：沿用 mTLS lane 上的长轮询 |
| App id 为主 | README 不变量 1 | 照搬；顺带消掉台账 id 与 canonical id 两套（core §2.7） |
| 持久化核心、Provider 会话、提示词队列、谱系、检查点、详情分页 | 见 `docs/orchestration-v2/` 与 `apps/server/src/orchestration-v2/` 各自模块 | 本表只列协议与证据口径；这些差异单独列在 [V2-alignment](V2-alignment.md) 的 B、C、D 节 |
| 旧数据导入 | `legacy-orchestration-migration.md` | 只导入会话目录元数据，不导入 turn 正文；每次启动增量导入旧台账（决定 E、plan §9） |

## 2. 目标架构（daemon 内）

```
 App（本机 lane）   Desktop 远程（SSH）   iPhone（Relay）
        │ subscribe / 命令            │                    │
        ▼                             ▼                    ▼
 ┌─────────────────────── daemon（host-process）──────────────────────┐
 │ 入口：每请求按证书指纹 + grant scope 重新授权（§5.5）               │
 │   │ 准备：canonical cwd、trust 指纹、附件与正文已落盘（core §2.3）   │
 │   ▼                                                                │
 │ Orchestrator（同步、纯函数决策，读 projection，不做 I/O）            │
 │   ▼                                                                │
 │ EventSink：orchestration.db 的一个事务（fail closed，core §2.5）   │
 │   orch_event + orch_p_* + orch_command + orch_outbox               │
 │   ▼ 提交后                                                          │
 │ 订阅唤醒（无 tick）     Effect worker：派发前复核 → 派发栅栏 →       │
 │                         Provider → 结果作为确定性 id 的命令回来      │
 │ 内容通道（不变）：trace archive、run-output、原生 transcript、正文   │
 └────────────────────────────────────────────────────────────────────┘
 Recorder Core 不变：独立进程，无 SQLite，只写 .scry/records；事件只引用它
```

新代码放 `src/host-runtime/orchestration/`。静态检查把它加入 main 的禁止导入清单（core §2.9；S3 的同类检查见 [P3-s1s3-plan](P3-s1s3-plan.md)「静态检查」）。核心模型见 [core](P4-orchestration-core.md)。

## 组件去留

| 组件 | P4 之后 | 依据 |
|---|---|---|
| 远程台账 `SessionLedger` + JSONL 文件 | **被取代**。转移规则进 Orchestrator；`since()` 变订阅；每次启动按位置增量导入；P4-2 起文件由日志异步镜像写出，供回退但不是严格保证；P4-6 删除 | plan §9 |
| 会话账本 `ConversationStore` | **部分成为视图**：turn 投递与结局由事件决定；turn 成员、顺序、原生绑定、删除与分支仍归它 | 决定 G、core §2.8 |
| `app-sessions.json` 目录 | **成为视图**：侧栏读 `orch_p_session`；过渡期由投影回写，供旧读者使用 | data §4.4 |
| `CommandReceipts`（内存 256） | **被取代**：`orch_command`，永久保留 | data §4.3 |
| 提问 broker | **拆分**：待答 Promise 留在进程内（握着 Provider 回调）；开、答、关成为事件与 projection | §1 H7 |
| `RunRegistry` | **保留**：进程内控制句柄、中止、焦点、准入权威。`departedState` 在 P4-3 删除 | `run-registry.ts:13-15` |
| `AppEventFeed` | **缩小**：持久类改由订阅承载；`terminal`、`oauth` 与 P5 的宿主通知留作易失提示 | protocol §5.3 |
| run 输出、trace、trace archive | **不变**：内容通道，事件只带指针 | §3 |
| 正文（提示与内联附件） | **新**：≤16 KiB 内联在 outbox 行，更大的放内容寻址文件；终态后删除，删会话时清除 | data §4.7 |
| 配对 / grant | **不变、不进日志权威**。授权永远读 `pairing-state.json`；P5 的批准方式写在 grant 的 `approvedVia` 里，也不进日志 | plan §7 |
| 客户端 intent 回执 | **保留为本地 outbox/缓存**，宿主回执为准；`logId` 变化后不自动重发 `unknown` | protocol §5.2、§6 |
