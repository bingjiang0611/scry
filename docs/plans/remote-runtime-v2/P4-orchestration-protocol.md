# P4 · §5 订阅协议 · §6 客户端

属于 [P4 设计](P4-orchestration-design.md)。行号说明见总体设计开头。2026-11-18 评审后修订：先作为 v2 能力上线再升 v3；回答的 `seq` 是扫描位置；回答上限与快照阈值统一；执行目标转发；keyset 分页；逐行授权；提示前沿触发；与 P5 通知对齐。

## 5. 订阅协议

### 5.1 请求与回答

一个新 op `subscribe`，由现有长轮询 lane 承载：

```
请求 { op: 'subscribe', views: View[], session?: SessionKeyRef,
       known?: { hostId: string, logId: string, seq: number },
       sessionsCursor?: string, waitMs: number }
View = 'sessions' | 'activeRuns' | 'detail'      // detail 必须带 session

回答 { subscribe:
  | { hostId, logId, seq, mode: 'snapshot', snapshot: Snapshot, hints?: Hint[] }
  | { hostId, logId, seq, mode: 'events',   events: Event[],   hints?: Hint[] }
  | { hostId, logId, seq, mode: 'idle',                         hints?: Hint[] } }

Snapshot = { sessions?: { rows, total: number | 'unavailable', nextCursor? },
             activeRuns?: { rows },
             detail?: { turns, legacyBefore?: true, firstPage?: HistoryPageRef } }
Event    = { seq, type, stream, at, payload, evidence? }
Hint     = { kind: 'run', runId, outputSeq } | { kind: 'terminal' }
         | { kind: 'oauth', url } | { kind: 'hostNotice' }
```

- `sessions` 快照分页用 keyset cursor：`(archived_at, ts, session_key)`，编码为不透明字符串，与 data §4.4 的索引一致。不用偏移量，所以翻页期间插入新行不会重复或漏行。不过，每一页都是一次新的快照，带的 `seq` 也更新。客户端翻页时要保留**第一页**的 `seq`，翻完后再从那里订阅增量；如果直接采用最后一页的 `seq`，会漏掉翻页期间插到游标之前的会话，以及 `ts` 改变的会话（W16 核验，2026-11-21）。
- `total` 是本 grant 可见行的数目，算不出就 `'unavailable'`（data §3.2 第 8 条）。

| lane | 谁 | views |
|---|---|---|
| `events`（App 本机已有） | App | `sessions` + `activeRuns`；`appEvents` 合并进来 |
| `status`（已有，今天承载 `liveRuns`） | Desktop 远程、iOS | `sessions` + `activeRuns` |
| `watch`（已有） | 全部 | 当前打开会话的 `detail` |

lane 定义见 `desktop-lane.ts:41`（今天 8 条，不是 PLAN 写的 4 条）与 `desktop-lane-routing.ts:13-15`。

### 5.2 cursor 语义与重置

- `seq` 是 `orch_event.seq`，跨 daemon 重启连续。`logId` 是库的身份（data §4.1），不是进程 epoch。今天 `AppEventFeed` 的 `epoch` 每次重启都变（`app-event-feed.ts:128-131`）；P4 之后 daemon 重启不再迫使客户端全量重读。`hostId` 让经执行目标转发的 cursor 不会串到另一台宿主（§5.7）。
- 回答快照的条件（任一）：
  1. 没有 `known`；`hostId` 或 `logId` 不同。
  2. `known.seq > 当前 seq`。这是**有意的改变**：今天台账对超前 cursor 报 `invalid_cursor`（`session-ledger.ts:332`），P4 改为回快照，覆盖库被替换、从备份恢复等情形。
  3. `known.seq < pruned_through`。
  4. 有界扫描：`MAX(seq) − known.seq > 4096` 时不扫描，直接快照，免得远程客户端为过滤大量与它无关的事件付出扫描代价。
  5. `known.seq` 之后与所请求 views 相关、且本 grant 可见的事件超过 128 条或 256 KB。
- **事件回答的上限就是第 5 条的阈值**：最多 128 条、256 KB。所以一个事件回答要么是完整的增量，要么改回快照；首稿里「每次最多 256 条」与「超过 128 条回快照」两个数字已统一。
- **回答的 `seq` 是本次扫描到的最后位置**（≤ 全局 seq），不是全局 seq。没有相关事件时它照样前进，客户端直接采用；有上限截断时也不会跳过事件。
- 客户端遇到不认识的事件类型：丢弃本地状态，下一次不带 `known`。
- **预留（core §2.10 R9，P4 不实现行为）**：客户端忽略行与载荷里不认识的可选字段（如谱系、`author`），只有不认识的类型才重置；请求预留可选的 `eventSet?: number`，宿主只发该集合内的类型，缺省为 1，即第一批。P4-5a 的解码器按此写，并加测试，免得 P6 为加字段再升协议。
- **`logId` 变了，客户端不得自动重发 `unknown` 的 intent**：旧回执随旧库失效，宿主已无法判定重复。显示 unknown，由用户决定。
- 快照的读法：一次同步读取 projection 与 `MAX(seq)`；此后只读按哈希引用的不可变内容（trace 归档、正文、历史页）。better-sqlite3 是同步的，决策与提交也是同步的，所以 projection 正好对应这个 `seq`；之后读到的内容由哈希固定，不会比它新。

### 5.3 持久事件与易失提示

- **事件**来自日志，带 seq，可补发。
- **提示**不进日志，不带 seq：run 输出前进（`outputSeq`）、终端有输出、MCP OAuth 页面、P5 的宿主通知。按主题合并（同一 run 只留最新）。**前沿触发**：一个主题的第一条立即发出，之后 50 ms 内的同主题提示合并成一条。daemon 重启即丢，客户端在快照里拿到每个活跃 run 的 `output_seq` 后自行补读。
- 这就是今天 P3f 的 `run` / `terminal` / `oauth` 通知（`app-event-feed.ts:12-25`）。`data` 由 session/turn 事件取代；`window` 中的 `turnDone`、`session`、`stopState` 由 run 事件取代，其余（`agent:error`、`backgroundWork`、`deleteArchivedProgress`）暂留为提示；`attention` 不在第一批，保持现状。
- **与 P5 对齐**：P5 给 app-event-feed 加一种通知、给设备加一个可协商宿主能力（[P5-host-security](P5-host-security.md) §4.3、[P5-host-cli](P5-host-cli.md) §5）。P4-3 中这种通知成为 `hostNotice` 提示；持久记录是 grant 上的 `approvedVia`（[P5-headless-host](P5-headless-host.md) §10.1 第 4 条），提示丢了可从设备列表补看。P5 的设备能力不是轮询 op，升 v3 时不删。

### 5.4 取代哪些轮询

| 今天 | 位置 | 之后 |
|---|---|---|
| `liveRuns` 长轮询，1 s 兜底 tick，每次重读历史版本 | `host-controller-watch.ts:21`、`:130-143`；设备侧 `desktop-client-run.ts:93-105`；iOS `RemoteRunStore.swift:434-436` | `subscribe(activeRuns)`，提交即唤醒，无 tick；外部会话由 `catalog.scan` 发现（core §2.9） |
| `watch` 的台账增量与 `runState` / `poll` / `questions` / `intentStatus` | `host-controller-watch.ts:97-128`；`inner-mtls-dispatch.ts:127-199` | `subscribe(detail)` 的 run 事件；`questions` 由 `orch_p_interaction` |
| App 每个 run 的「watch + trace」双往返与 15 s 兜底 | `daemon-run-runtime.ts:24`、`:264-306`、`:324` | 生命周期来自订阅；只在有提示时读 trace（一次往返） |
| App 发现别处发起的 run 时查 `liveRuns` | `daemon-run-discovery.ts:48-50` | `activeRuns` 增量 |
| renderer 远程视图 250 ms–5 s 读循环；发送后 1.5 s | `RemoteChatShared.ts:8-12`、`RemoteChatControls.tsx:100`、`:244`、`RemoteChatExecution.tsx:25` | main 持订阅，变化推给 renderer；renderer 不计时 |
| iOS 不支持 `watch` 时 800 ms 轮询 | `RemoteRunStore.swift:2701` | P4-5b 删除（v3 宿主必有 `subscribe`） |
| `catalogSnapshot` 中的 `sessionsPage` | `host-controller-catalog-snapshot.ts:37` | `subscribe(sessions)` 首帧 |

保留：`catalogSnapshot` 的 `info` / `projects` / `providers` 部分。它们是能力与配置，不是事件，仍按 revision 短回答；不缓存无版本的能力（PLAN 不变量 5）。

### 5.5 每请求重新授权与逐行可见性

- 每次唤醒都重跑 `authorizeDevice(peer)` 与 cwd 授权（与 `host-controller-watch.ts:133`、`:148` 相同），撤销的设备在下一次唤醒失败。撤销时按指纹断开连接，沿用现状。
- **逐行授权**：读路径用行里固定的 canonical cwd 判断是否在远程项目根内，不再对每行 `realpath`（今天每次 `sessionsPage` 对每个 cwd 做一次，`host-runtime.ts:176-181`）。写路径在准备阶段重新 canonical 化（core §2.3）。
- `scope: local` 拿完整行；`scope: remote` 拿裁剪行（D2 的规则，[STATUS-BATCH4](STATUS-BATCH4.md) 2026-11-07 第 3 行）：cwd 不在远程项目根内则整行不可见；`prompt_preview` 截 200 字符；只给本机的字段（例如今天的 `settledTail`，`host-controller-desktop-reads.ts:34`）不出现。
- 事件的 `scope` 与 `cwd` 列（data §4.2）共同决定可见性，所以 projection 行删除之后仍能判断。会话删除以墓碑 `session.deleted { session_key }` 发给曾能看到它的远程客户端，客户端据此移除本地缓存。
- 全局 `seq` 的跳跃会让远程设备知道「别处发生了事」，但看不到内容；与今天 `liveRuns` 的 revision 变化泄露的信息量相同。

### 5.6 背压与大块内容

- 每条 lane 同一时刻只有一个请求（`desktop-lane.ts`），这就是背压。回答上限见 §5.2，客户端立刻再问。
- 持久事件不合并、不丢弃；客户端落后太多就拿快照。
- `detail` 快照的 `firstPage` 来自内容通道（历史页缓存与 trace 归档），与 projection 在同一次请求里返回；超过 512 KiB 用现有分块（`DESKTOP_HISTORY_CHUNK_BYTES`，`shared/desktop-remote.ts:175`）。所以「首屏由快照一次返回」严格说是「一次请求，超过 512 KiB 时加分块续读」。

### 5.7 协议版本与能力（决定 F，维护者 2026-11-18）

| 段 | 做什么 | 版本 |
|---|---|---|
| P4-3 | App 切到本机 op；网络端点回答 `unsupported_op` | 不变；维护者 2026-11-10 已确认本机流式 op 不违反「协议版本不变」（[STATUS-BATCH4](STATUS-BATCH4.md)） |
| P4-5a | 宿主在 `info` 里声明 `subscribe: 1`（`DesktopRemoteInfo`，`shared/desktop-remote.ts:192`）。Desktop 与 iOS 见到能力就用 `subscribe`，否则走旧 op。旧 op 原样保留。真机验证 | 仍是 2。先例：`providerDiscovery: 2`、`traceDelta: 1`（`:145`、`:157`）；P5 的设备通知也走同样的可协商能力 |
| P4-5b | 一次把 `REMOTE_PROTOCOL_VERSION` 从 2 升到 3（`shared/desktop-remote.ts:180`），iOS 的 `RelaySession.protocolVersion`（`RelaySession.swift:43`）同批。**只删旧 op**：`liveRuns`、`watch`、`runState`、`poll`、`questions`、`intentStatus` 与 `catalogSnapshot` 的会话部分；不加新功能。版本闸门在任何 op 之前拒绝（`inner-mtls-dispatch.ts:76-77`） | 3 |

- **不变量 7 的裁定**：PLAN「不做协议兼容层」。维护者明确裁定：P4-5a 到 P4-5b 之间新旧 op 并存，是为了在真机上验证新路径，不是长期兼容层；并存在升 v3 时结束。PLAN「已定」记了这条。
- **执行目标转发**（手机 → Mac1 → Mac2）：今天转发只允许白名单 op（`execution-targets.ts:14-18`），含 `watch`、`liveRuns`、`runState`、`poll`、`questions`、`intentStatus`；各 op 的键与校验在 `:73-79`、`:96-97`。P4-5a 把 `subscribe` 加入白名单与校验；Mac1 只在 Mac2 也声明 `subscribe: 1` 时向手机声明可转发。cursor 带 `hostId`（§5.2）。P4-5b 三方的版本一起升，白名单同批删旧 op。
- **P5**：不改版本，只加一个可协商宿主能力（[P5-host-cli](P5-host-cli.md) §5）。首稿写的「P5 之后若有远程可见变化取 4」已删：P5 的变化走能力，不占版本号。
- **iOS 的 `info.protocol`**：首稿记的「iOS 要求 1、宿主回 2」已在 `172074a2` 单独修复：`TransportRunOperations.swift:201` 改为与 `RelaySession.protocolVersion` 比较。不再属于 P4-5；升 v3 时它随 `RelaySession.protocolVersion` 一起变。

## 6. 客户端

| 顺序 | 客户端 | 改动 | 兼容 |
|---|---|---|---|
| 1（P4-3） | App（本机） | `DaemonEventPump` 改为 `subscribe`；`DaemonRunRuntime` 不再每个 run 读 `watch`，生命周期来自事件，只在提示到达时读 trace；`DaemonRunDiscovery` 删除；`departedState` 与 `settledTail` 删除（终态 run 留在 `orch_p_run` 24 h，trace 从归档读）；`agent:start` 的 `commandId` 进 `orch_command` | 同一构建，无版本问题 |
| 2（P4-4） | App renderer | 新增 typed preload 读 projection：侧栏读 `sessions`，会话视图读 `detail`；删除 `useAgentSession.ts:208-213` 的合并，顺序由宿主给出；用量缺失显示加载中或 unavailable，不显示 0 | sandbox、`contextIsolation` 不变；renderer 只收 projection 行与提示，不碰 SQLite |
| 3（P4-5a） | Desktop 远程客户端 | 有能力时 `desktop-client-run.ts` 的 `liveRuns`/`watch` 改为 `subscribe`；renderer 的读循环删除；C1 的 `desktop-client.state` 保留为本地 outbox，与宿主回执冲突时以宿主为准，不一致显示 unknown 并按 intent id 核对 | v2 能力协商；无能力时走旧 op |
| 3（P4-5a） | iOS | 有能力时 `RemoteRunStore.swift` 的 `liveRuns`、`watch` 改为 `subscribe`；`outbox.json` 与历史缓存保留，历史缓存用于首屏先画，随后由快照校正 | 同上；真机签名客户端由维护者安装（[b4-s0-final](status/b4-s0-final.md)） |
| 4（P4-5b） | 宿主、Desktop、iOS、转发 | 删除旧 op 的客户端分支与 iOS 800 ms 回退 | v3 硬校验；三方同批 |

v3 宿主收到 v2 客户端的请求时，回答 `protocol_mismatch` 并带两边版本（`remote-protocol.ts:15-19`），手机显示「请更新 Scry」（`ConnectionCopy.swift:134`）。这是 PLAN 接受的行为（不变量 7）。P4-5a 已让新路径在 v2 上先跑过真机，所以 P4-5b 的风险只剩「手机没更新前不可用」这一段。
