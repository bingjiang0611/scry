# P4 · §5 订阅协议 · §6 客户端

属于 [P4 设计](P4-orchestration-design.md)。行号以 `72c83932` 为准。

## 5. 订阅协议

### 5.1 请求与回答

一个新 op `subscribe`，由现有长轮询 lane 承载：

```
请求 { op: 'subscribe', views: View[], session?: SessionKeyRef,
       known?: { logId: string, seq: number }, waitMs: number }
View = 'sessions' | 'activeRuns' | 'detail'      // detail 必须带 session

回答 { subscribe:
  | { logId, seq, mode: 'snapshot', snapshot: Snapshot, hints?: Hint[] }
  | { logId, seq, mode: 'events',   events: Event[],   hints?: Hint[] }
  | { logId, seq, mode: 'idle',                         hints?: Hint[] } }

Snapshot = { sessions?: { rows, total, nextCursor? },
             activeRuns?: { rows },
             detail?: { turns, legacyBefore?: true, firstPage?: HistoryPageRef } }
Event    = { seq, type, stream, at, payload, evidence? }
Hint     = { kind: 'run', runId, outputSeq } | { kind: 'terminal' } | { kind: 'oauth', url }
```

| lane | 谁 | views |
|---|---|---|
| `events`（App 本机已有） | App | `sessions` + `activeRuns`；`appEvents` 合并进来 |
| `status`（已有，今天承载 `liveRuns`） | Desktop 远程、iOS | `sessions` + `activeRuns` |
| `watch`（已有） | 全部 | 当前打开会话的 `detail` |

lane 定义见 `desktop-lane.ts:41`（今天是 8 条，不是 PLAN 写的 4 条）与 `desktop-lane-routing.ts:13-15`。

### 5.2 logId / seq 语义与重置

- `seq` 是 `orch_event.seq`，跨 daemon 重启连续。`logId` 是库的身份（§4.1），**不是**进程 epoch。今天 `AppEventFeed` 的 `epoch` 每次重启都变（`app-event-feed.ts:128-131`），P4 之后 daemon 重启不再迫使客户端全量重读。
- 回答快照的条件（任一）：没有 `known`；`logId` 不同（库被重建）；`known.seq > 当前 seq`；`known.seq < pruned_through`；`known.seq` 之后与所请求 views 相关的事件超过 128 条或 256 KB（t3code `ThreadStream.ts:18` 的规则加字节上限）。
- 增量按 `seq` 升序，只含与 views 相关、且本 grant 可见的事件；回答的 `seq` 是当前全局 `seq`，客户端直接采用。
- 客户端遇到不认识的事件类型：丢弃本地状态，下一次不带 `known`。
- 快照在一次同步读里取 projection 与 `MAX(seq)`。better-sqlite3 是同步的，决策与提交也是同步的，所以读到的 projection 正好对应这个 `seq`。

### 5.3 持久事件与易失提示

- **事件**来自日志，带 seq，可补发。
- **提示**不进日志，不带 seq：run 输出前进（`outputSeq`）、终端有输出、MCP OAuth 页面。按主题合并（同一 run 只留最新），50 ms 合并窗口。daemon 重启即丢，客户端在快照里拿到每个活跃 run 的 `output_seq` 后自行补读。
- 这就是今天 P3f 的 `run` / `terminal` / `oauth` 通知（`app-event-feed.ts:12-25`）。`data`、`window`、`attention` 三类：`data` 由 session/turn 事件取代；`window` 中的 `turnDone`、`session`、`stopState` 由 run 事件取代，其余（`agent:error`、`backgroundWork`、`deleteArchivedProgress`）暂留为提示；`attention` 不在第一批，保持现状。

### 5.4 取代哪些轮询

| 今天 | 位置 | 之后 |
|---|---|---|
| `liveRuns` 长轮询，1 s 兜底 tick，每次重读历史版本 | `host-controller-watch.ts:21`、`:130-143`；设备侧 `desktop-client-run.ts:93-105`；iOS `RemoteRunStore.swift:434-436` | `subscribe(activeRuns)`，提交即唤醒，无 tick |
| `watch` 的台账增量与 `runState` / `poll` / `questions` / `intentStatus` | `host-controller-watch.ts:97-128`；`inner-mtls-dispatch.ts:127-199` | `subscribe(detail)` 的 run 事件；`questions` 由 `orch_p_interaction` |
| App 每个 run 的「watch + trace」双往返与 15 s 兜底 | `daemon-run-runtime.ts:24`、`:264-306`、`:324` | 生命周期来自订阅；只在有提示时读 trace（一次往返） |
| App 发现别处发起的 run 时查 `liveRuns` | `daemon-run-discovery.ts:48-50` | `activeRuns` 增量 |
| renderer 远程视图 250 ms–5 s 读循环；发送后 1.5 s | `RemoteChatShared.ts:8-12`、`RemoteChatControls.tsx:100`、`:244`、`RemoteChatExecution.tsx:25` | main 持订阅，变化推给 renderer；renderer 不计时 |
| iOS 不支持 `watch` 时 800 ms 轮询 | `RemoteRunStore.swift:2701` | 删除（v3 宿主必有 `subscribe`） |
| `catalogSnapshot` 中的 `sessionsPage` | `host-controller-catalog-snapshot.ts:37` | `subscribe(sessions)` 首帧 |

保留：`catalogSnapshot` 的 `info` / `projects` / `providers` 部分。它们是能力与配置，不是事件，仍按 revision 短回答；不缓存无版本的能力（PLAN 不变量 5）。旧决定 5 因此不再待决。

### 5.5 每请求重新授权与按 scope 裁剪

- 每次唤醒都重跑 `authorizeDevice(peer)` 与 cwd 授权（与 `host-controller-watch.ts:133`、`:148` 相同），撤销的设备在下一次唤醒失败，而不是在整个等待期内有效。撤销时按指纹断开连接，沿用现状。
- `scope: local` 拿完整行；`scope: remote` 拿裁剪行（D2 的规则，[STATUS-BATCH4](STATUS-BATCH4.md) 2026-11-07 第 3 行）：cwd 必须在远程项目根内，否则整行不可见；`prompt_preview` 截 200 字符；只给本机的字段（例如收尾后的 trace 尾部，今天的 `settledTail`，`host-controller-desktop-reads.ts:34`）不出现。
- 事件的 `scope` 列（§4.2）加上 cwd 授权共同决定可见性。全局 `seq` 的跳跃会让远程设备知道「别处发生了事」，但看不到内容；这与今天 `liveRuns` 的 revision 变化泄露的信息量相同。

### 5.6 背压与大块内容

- 每条 lane 同一时刻只有一个请求（`desktop-lane.ts`），这就是背压。宿主每次回答最多 256 个事件或 256 KB，客户端立刻再问。
- 持久事件不合并、不丢弃；客户端落后太多就拿快照。
- `detail` 快照的 `firstPage` 来自内容通道（历史页缓存与 trace 归档），与 projection 在同一次请求里返回；超过 512 KiB 用现有分块（`DESKTOP_HISTORY_CHUNK_BYTES`，`shared/desktop-remote.ts:175`）。所以「首屏由快照一次返回」严格说是「一次请求，超过 512 KiB 时加分块续读」，验收按此写（§8）。

### 5.7 协议版本

- P4-3（App 切换）只加本机 op，网络端点回答 `unsupported_op`，不升版本；维护者 2026-11-10 已确认本机流式 op 不违反「协议版本不变」（[STATUS-BATCH4](STATUS-BATCH4.md)）。
- P4-5 一次把 `REMOTE_PROTOCOL_VERSION` 从 2 升到 3（`shared/desktop-remote.ts:180`），同时删除 `liveRuns`、`watch`、`runState`、`poll`、`questions`、`intentStatus` 与 `catalogSnapshot` 的会话部分。不做兼容层，版本闸门在任何 op 之前拒绝（`inner-mtls-dispatch.ts:76-77`）。
- P5 声明不改版本（[P5-host-cli](P5-host-cli.md) §5），`host-admin.sock` 自带 `version: 1`。所以 2 → 3 由 P4 占用；P5 之后若有远程可见变化，取 4。
- 现存问题：宿主 `info` 回答的 `protocol` 已是 2（`desktop-host-reader.ts:161`，提交 `e2d74262` 由 1 改为常量），而 iOS 仍要求 `info.protocol == 1`（`experiments/remote-g0/swift/Sources/RemoteTransport/TransportRunOperations.swift:201`），按代码阅读，带 `detail` 的 Provider 发现会以 `unexpectedReply` 失败。只是读码结论，未在真机验证。P4-5 应把两个版本号合一，或至少一起改。

## 6. 客户端

| 顺序 | 客户端 | 改动 | 兼容 |
|---|---|---|---|
| 1（P4-3） | App（本机） | `DaemonEventPump` 改为 `subscribe`；`DaemonRunRuntime` 不再每个 run 读 `watch`，生命周期来自事件，只在提示到达时读 trace；`DaemonRunDiscovery` 删除；`departedState` 与 `settledTail` 删除（终态 run 留在 `orch_p_run` 24 h，trace 从归档读）；`agent:start` 的 `commandId` 进 `orch_command` | 同一构建，无版本问题 |
| 2（P4-4） | App renderer | 新增 typed preload 读 projection：侧栏读 `sessions`，会话视图读 `detail`；删除 `useAgentSession.ts:208-213` 的合并，顺序由宿主给出 | sandbox、`contextIsolation` 不变；renderer 只收 projection 行与提示，不碰 SQLite |
| 3（P4-5） | Desktop 远程客户端 | `desktop-client-run.ts` 的 `liveRuns`/`watch` 改为 `subscribe`；renderer 的读循环删除；C1 的 `desktop-client.state` 保留为本地 outbox，与宿主回执冲突时以宿主为准，不一致显示 unknown 并按 intent id 核对（REVIEW-BATCH1 的建议，旧决定 4 不再待决） | v3 硬校验 |
| 3（P4-5） | iOS | `RemoteRunStore.swift` 的 `liveRuns`、`watch`、800 ms 回退改为 `subscribe`；`outbox.json` 与历史缓存保留，历史缓存用于首屏先画，随后由快照校正 | v3 硬校验；宿主与手机必须同批安装（真机签名客户端由维护者安装，见 [b4-s0-final](status/b4-s0-final.md)） |

iOS 在协议硬校验下的结果：v3 宿主收到 v2 手机的请求时，回答 `protocol_mismatch` 并带两边版本（`remote-protocol.ts:15-19`），手机显示「请更新 Scry」（`ConnectionCopy.swift:134`）。这是 PLAN 接受的行为（不变量 7）。代价：P4-5 合入后、手机更新前，手机不可用。
