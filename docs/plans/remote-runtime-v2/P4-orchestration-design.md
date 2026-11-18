# P4 · 编排事件日志：总体设计

状态：设计稿，不含实现。取代 Batch 1 的 [P4-event-log-contract](P4-event-log-contract.md)：那份写于 daemon 之前，把组件放在 `src/main/remote` 与 Electron main。本文依据分支 `claude/scry-performance-optimization-46ngcf` 的 `72c83932`，行号以该提交为准。

| 文件 | 内容 |
|---|---|
| 本文 | 结论、t3code 对照、目标架构（§2）、组件去留 |
| [P4-orchestration-current](P4-orchestration-current.md) | §1 现状映射：今天谁在决定「发生了什么」 |
| [P4-orchestration-data](P4-orchestration-data.md) | §3 证据合同；§4 表结构、事件类型、命令回执、压缩与保留 |
| [P4-orchestration-protocol](P4-orchestration-protocol.md) | §5 订阅协议；§6 三类客户端的改动与顺序 |
| [P4-orchestration-plan](P4-orchestration-plan.md) | §7 依赖；§8 性能；§9 迁移；§10 测试；§11 需要维护者决定；§12 与现有文档的矛盾；§13 建议术语 |

## 0. 结论

1. 今天宿主侧 13 处、客户端 4 处各自记录或推导「发生了什么」（§1）。宿主侧有 7 处只在内存：daemon 重启后命令回执、提问去重、会话 run 交接、未读集合、事件流全部丢失，客户端只能整体重读。
2. P4 只把**决定**收进一处：run 生命周期、会话 turn 投递、会话目录元数据、提问/审批生命周期。trace、run 输出、原生 transcript、`.scry/records` 仍是内容通道，事件只引用。
3. 库已经有了：daemon 用 `better-sqlite3@12.11.1`（`src/daemon/host-process.ts:76` → `src/main/db-connection.ts:44`），不需要 `node:sqlite`。但现有 `scry.db` 加载失败时整体降级为 no-op（`db-connection.ts:55-61`），编排权威不能降级，见决定 A。
4. 建议 S3（删除进程内路径）先于 P4-2（日志成为权威）。P4-0、P4-1（纯决策器、影子写）只在 daemon 内，可与 S3 并行（§7）。
5. 远程协议只在 P4-5 升一次（2 → 3），desktop 与 iOS 同批。本机 App 先切，用本机 op，不升版本（沿用 P3f 的先例）。
6. 工期估约 8.5 周（不含 S3），高于 PLAN 的 5–6 周：PLAN 写于 daemon 之前，没有计入两本账合并、旧台账导入与 S3 的先后关系（§9）。

## t3code 对照

参考 `pingdotgg/t3code` `8cf97b5f`（2026-11-18）的 `docs/orchestration-v2/`、`docs/internals/overview.md` 与 `apps/server/src/orchestration-v2/`，只读，不拷代码。

| 概念 | t3code | 本设计 |
|---|---|---|
| 串行决策，不做 I/O | `Orchestrator.ts`（overview「Durable intent and side effects」） | 照搬。Node 单线程 + 同步事务，串行是天然的；异步准备在进入决策器之前完成（§2.2） |
| 一个事务提交事件、projection、回执、outbox | `EventSink.ts` | 照搬 |
| 重复命令 id 返回同一回执，回执带已提交序号 | orchestration-v2 README「Existing Platform Boundaries」 | 照搬；回执表 `orch_command`（§4.3） |
| 进程丢失：进程绑定的副作用取消，可重放的重新排队 | `EffectOutbox.ts:142-163`、`reconcileAfterProcessLoss` 连 `pending` 的 `provider-turn.start` 也取消 | **不同**：保留 Scry 现有的「已记录、从未领取的 intent 重启后派发一次」（`host-controller-surface.ts:107-116`），作为唯一显式例外，见决定 B |
| 重连：缺口 ≤128 事件补发，否则快照 | `ThreadStream.ts:18` | 照搬 128，并加 256 KB 字节上限（与 `app-event-feed.ts:47` 一致） |
| 推送前 50 ms 合并 | `ThreadLiveEventCoalescer.ts:18` | 只用于易失提示（hint），持久事件不合并 |
| 事件只保留约 1 天，projection 不能从日志重建 | `ProjectionMaintenance.ts:42` | **不同**：建议 30 天，见决定 C |
| 原始 Provider 帧是可轮转诊断日志 | README「Conceptual Layers」 | **不同**：PLAN 明确不做；原始证据长期保留，事件只引用（§3） |
| 命令输出不进事件（`CommandOutputHub.ts`） | — | 同理：run 输出与 trace 走内容通道 |
| WebSocket 推送 | `ws.ts` | **不同**：沿用 mTLS lane 上的长轮询 |
| App id 为主，Provider id 为引用 | README 不变量 1 | 照搬；顺带消掉台账 run id 与 canonical run id 两套 id（§2.4） |
| 旧数据导入器 | `legacy-orchestration-migration.md` | 只导入会话目录元数据，不导入 turn 正文（决定 E） |

## 2. 目标架构（daemon 内）

```
 App（本机 lane）   Desktop 远程（SSH）   iPhone（Relay）
        │ subscribe / 命令            │                    │
        ▼                             ▼                    ▼
 ┌─────────────────────── daemon（host-process）──────────────────────┐
 │ 入口：每请求按证书指纹 + grant scope 重新授权（§5.5）               │
 │   │ 命令（已准备：canonical cwd、trust 指纹、附件已提交）             │
 │   ▼                                                                │
 │ Orchestrator（同步、纯函数决策，读 projection，不做 I/O）            │
 │   ▼                                                                │
 │ EventSink：一个 better-sqlite3 事务                                 │
 │   orch_event + orch_p_* + orch_command + orch_outbox               │
 │   ▼ 提交后                                                          │
 │ 订阅唤醒（无 tick）     Effect worker：领取 outbox → 运行管线/       │
 │                         Provider → 结果作为新命令回到 Orchestrator   │
 │ 内容通道（不变）：trace archive、run-output、原生 transcript         │
 └────────────────────────────────────────────────────────────────────┘
 Recorder Core 不变：独立进程，无 SQLite，只写 .scry/records；事件只引用它
```

新代码放 `src/host-runtime/orchestration/`。S3 的静态检查（[P3-s1s3-plan](P3-s1s3-plan.md)「静态检查」）把它加入 main 禁止导入清单。

### 2.1 Orchestrator

- 输入：已准备的命令 `{ commandId, actor, scope, type, payload, prepared }`。`actor` 是证书指纹（远程）或本机 grant 指纹；`commandId` 按 actor 作用域，沿用 `scopedIntentId`（`remote-gateway.ts:227`）。
- 决策：`decide(command, view) → { events, effects, receipt }`。`view` 是当前 projection 的只读视图。run 状态机取自 `SessionLedger` 的转移表（`session-ledger.ts:102-108`）与重复检测（`:294-307`），抽成纯函数后原样复用。
- 拒绝也是决策：`receipt.status = 'rejected'` 加原因，写回执、不写事件。事务本身失败则什么也没提交，没有回执，客户端可以重试（与 `command-receipts.ts:11` 的「失败不缓存」同理）。

### 2.2 准备与决策的边界

决策必须同步，但很多前置检查是异步的：canonical cwd（`realpath`）、trust gate 指纹、附件提交、交接历史读取。规则：

1. 异步检查在进入 Orchestrator 之前完成，结果作为 `prepared` 固定在命令里（例如 cwd 的 canonical 值、executable fingerprint）。
2. 决策器只用 `prepared` 与 projection 判断，不再碰文件系统。
3. Effect worker 在真正启动 Provider 前**再验一次** trust gate，校验失败 fail closed，写 `run.failed`（`trust_gate_rejected`）。准备阶段的结果不是授权缓存。

### 2.3 EventSink 与 Effect worker

- 一个同步事务写四类表（§4）。提交后才唤醒订阅、才把 outbox 行交给 worker。
- 领取：`UPDATE orch_outbox SET state='running', claimed_at, lease_owner` 单独提交，**先于**调用 Provider。这就是今天 `markDispatched` 的作用（`remote-dispatcher.ts:68-80`：持久转移是派发的栅栏）。
- worker 的结果（Provider 已结束、trace 已归档、记录已写）不直接改表，而是作为系统命令回到 Orchestrator，保持单写者。
- 重启时（`host-process.ts:218-226` 的启动恢复之后、开放 `local.sock` 之前）按策略表处理未完成行：`running` → `voided` + run `failed(host_restarted)`；`pending` 见决定 B。

### 2.4 一个 run 一个 id

今天一次设备 run 有台账 id（UUID）和 canonical id（`remote-run-…`），靠 `bound` 标记对上（`daemon-run-evidence.ts:15-25`）；App 启动后要等最多 3 s 绑定（`daemon-run-runtime.ts:28`）。统一对话的 run 已经是同一个 id（[P3-conversation-send](P3-conversation-send.md)）。P4 在决策时分配 canonical id 写进 `run.intent_recorded`，派发沿用它；台账 id 只作为旧设备 intent 的别名保留到 P4-6。实现前要确认运行管线接受预分配 id（会话 run 已证明可以）。

## 组件去留

| 组件 | P4 之后 | 依据 |
|---|---|---|
| 远程台账 `SessionLedger` + JSONL 文件 | **被取代**。转移规则进 Orchestrator；`since()` 变订阅；启动时导入一次，P4-2 起文件由日志镜像写出供回退，P4-6 删除 | §11 旧决定 1 |
| 会话账本 `ConversationStore` | **部分成为视图**：turn 的开始、投递结果、恢复由事件决定；会话元数据、绑定、删除与分支状态仍归它，留到后续 | 决定 G |
| `app-sessions.json` 目录 | **成为视图**：侧栏读 `orch_p_session`；文件在过渡期由投影回写，供旧读者使用 | §4.4 |
| `CommandReceipts`（内存 256） | **被取代**：`orch_command` | §4.3 |
| 提问 broker | **拆分**：待答 Promise 留在进程内（握着 Provider 回调）；开、答、关成为事件与 projection | §1 H7 |
| `RunRegistry` | **保留**：进程内控制句柄、中止、焦点。`departedState` 在 P4-3 删除 | `run-registry.ts:13-15` |
| `AppEventFeed` | **缩小**：持久类通知改由订阅承载；`terminal`、`oauth` 等易失提示留下 | §5.3 |
| run 输出、trace、trace archive | **不变**：内容通道，事件只带指针 | §3 |
| 配对 / grant | **不变、不进日志权威**。授权永远读 `pairing-state.json`，事件日志不是授权缓存 | §7 P5 |
| 客户端 intent 回执 | **保留为本地 outbox/缓存**，宿主回执为准 | §6 |
