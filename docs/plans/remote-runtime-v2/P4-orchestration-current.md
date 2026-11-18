# P4 · §1 现状映射：今天谁在决定「发生了什么」

属于 [P4 设计](P4-orchestration-design.md)。行号以 `72c83932` 为准，2026-11-18 在 `172074a2` 上复核（所引文件未改）。「宿主」指 daemon 进程（`src/daemon/host-process.ts`）；它装配的大部分模块仍在 `src/main/**`，与 App 共用源码，但运行在 daemon 里。

## 1.1 宿主侧

| # | 是什么 | 位置 | 持久化 | 消费者 | daemon 重启后 |
|---|---|---|---|---|---|
| H1 | **远程台账**：run 生命周期 `intent_recorded → run_dispatched → run_progress* → settled/failed/cancelled`，`since(cursor)` | `remote/session-ledger.ts:13-28`、`:270-287`、`:331-341`；文件 `remote/session-ledger-file.ts:23-142` | `userData/remote/session-ledger.log`（JSONL，每条 fsync + 目录 fsync，`:139-141`）+ 快照；8 MiB 上限、6 MiB 压缩（`:10-12`）。intent 的 `detail` 带提示与 base64 附件，≤1,200,000 字符（`session-ledger.ts:86`） | 设备 `poll`/`watch`；App `DaemonRunRuntime`；`intentRun` 回答丢失的提交回执（`:355-360`） | 保留。`dispatched` 记为 `failed(host_restarted)`，`recorded` 派发一次（`host-controller-surface.ts:107-117`）；P4 改变这条，见 core §2.4 |
| H2 | **run 进度标记**：`bound`、`admitted`、`started`、`session`、`question_*`、`stop_requested`、`result`（带 tokens/cost）、`*_capture_failed` | 写成 H1 的 `run_progress.detail` JSON，例：`remote-run-binding.ts:196`、`remote-interaction-broker.ts:66-71` | 同 H1，单条 ≤4096 字符（`session-ledger.ts:87`） | App 解析 `bound`（`daemon-run-evidence.ts:15-25`）；设备 | 同 H1 |
| H3 | **会话账本**（统一对话）：turn 的 `begin`/`settle`，投递状态 `pending/accepted/unknown/not_sent` | `conversation-store.ts:93-186`、`conversation-turns.ts:99`、`:210`、`:299-303` | `userData/conversations/<id>.json`，原子整文件替换 | App、`conversation:send`、交接历史 | 保留。启动恢复把无 owner 的 `pending` 记为 `unknown`（`conversation-turns.ts:303`），即使可证明未发送（[P3-conversation-send](P3-conversation-send.md)「重启的语义」） |
| H4 | **会话目录**：侧栏行、标题、置顶、存档、`lastRunOutcome` | `app-store.ts:128-129` | `userData/app-sessions.json`（可恢复 JSON + `.bak`） | App 侧栏；设备 `sessionsPage` 每次调用现算（`host-runtime.ts:170-200`，对每个 cwd 做一次 realpath） | 保留 |
| H5 | **命令回执**（幂等） | `command-receipts.ts:48-52`；App 侧 `agent-runtime-ipc.ts:56`；daemon 侧 `create-run-pipeline.ts:115` | 内存，256 条，失败不缓存 | `agent:start`、远程启动 | **丢失**。重启后同一 `commandId` 会当作新命令 |
| H6 | **会话 run 交接** `ManagedLaunches` | `remote/managed-launches.ts:29`、`:46-62` | 内存，最多 16 | `createRemoteRunBinding` | **丢失**，派发时以 `conversation_start_unavailable` 失败 |
| H7 | **提问 / 审批** | 待答：`user-question.ts:23-24`（Promise 握着 Provider 回调）；远程去重：`remote-interaction-broker.ts:6`、`:81-113`（内存 512 条） | 开、答、关写进 H1 进度；待答本身只在内存 | 设备 `questions`/`answerQuestion`、`liveRuns`；App `daemon-run-questions.ts` | 待答丢失（run 已 `host_restarted`）；重复回答收到 `question_not_pending` 而非 `duplicate` |
| H8 | **运行登记** `RunRegistry` | `run-registry.ts:17-163`；离场状态 `:13-15`、`:140-150`（8 个、60 s） | 内存 | 准入、删除、`liveRuns` 的本机部分、`listSessions` 的 `isActive` | 丢失 |
| H9 | **App 事件流** `AppEventFeed` | `remote/app-event-feed.ts:12-25`、`:45-47`、`:128-131`；接线 `host-process.ts:88-93`、`:168-172`、`:339` | 内存环形缓冲 512 项 / 256 KB，`epoch` = 进程 | App `DaemonEventPump` | `epoch` 变化，App 必定 `reset` 全量重读 |
| H10 | **run 输出（影子内容）** | `remote/run-output-log.ts:1-14`、`:50-56` | 每 run 分块文件（worker store），1 MB / 4000 条上限 | 设备 `output`；`watch` 的 `output:'wake'` | 保留 |
| H11 | **trace 与归档**：live trace、`trace-archive-turns-v1`、`trace-archives-v2`；SQLite `scry.db`（spans、用量）与 `db-turn-outbox` | `transcript-archive.ts:381-390`；`db-connection.ts:42-63`；`db-outbox.ts:15-39` | 文件 + SQLite（WAL，`user_version` 16，`db-migrations.ts:5-21`） | 历史页、trace 读、统计 | 保留；SQLite 加载失败时降级为不写不查（`db-connection.ts:55-61`） |
| H12 | **长轮询与快照的现算结果**：`liveRuns`（列表哈希作 revision，1 s 兜底 tick 并每次重读历史版本）、`watch`、`catalogSnapshot`（内容哈希）、`sessionsPage` 快照（30 s、32 份） | `host-controller-watch.ts:15-24`、`:97-128`、`:130-143`（1 s tick 每次重读历史版本，`:136`、`:141`，这也是今天发现终端里原生 CLI 会话的唯一途径）；`host-controller-catalog-snapshot.ts:30-42`；`remote-gateway-session-list.ts:10-11` | 内存，现算 | 设备、App | 丢失；客户端拿新 revision |
| H13 | **未读集合** `DockBadgeState` | `dock-badge.ts:12`、`:86`、`:192`；经 H9 的 `attention` | 内存 | App 角标 | 丢失 |

## 1.2 客户端侧

| # | 是什么 | 位置 | 持久化 | 重启 / 断线后 |
|---|---|---|---|---|
| C1 | Desktop 远程 intent 回执 `recorded/unknown` | `shared/desktop-remote.ts:243-256`；`desktop-client-base.ts:111-115`；文件名 `desktop-client-validation.ts:17` | `desktop-client.state`（加密，≤4 MiB） | `unknown` 用 `resolveIntent` 按 intent id 核对（`desktop-client-base.ts:228`） |
| C2 | iOS 待发 outbox 与历史缓存 | `RemoteRunStore.swift:418-419`、`:740-772`；`RemoteHistoryCache.swift` | App Support 下 `outbox.json`、历史缓存 | 重启后继续投递；`watch` 不支持时 800 ms 轮询（`RemoteRunStore.swift:2701`） |
| C3 | App 窗口的 run 视图 | `daemon-run-runtime.ts:24-28`、`:264-306`、`:312-325`；`daemon-run-wakes.ts:8-53`；`daemon-run-discovery.ts:18`、`:48-50` | 内存游标 | 每次唤醒读 `watch` + trace（两次往返）；无唤醒 15 s 兜底；新 run 靠查 `liveRuns` 发现 |
| C4 | renderer 自己拼顺序 | 本机：`useAgentSession.ts:208-213`（历史快照与活跃 run 合并）；远程：`remote-trace.ts:30`、`RemoteChatControls.tsx:73-90` | 内存 | 远程视图 250 ms 起、空闲倍增到 5 s 的读循环（`RemoteChatShared.ts:8-12`、`RemoteChatControls.tsx:100`、`:244`）；发送后 1.5 s（`RemoteChatExecution.tsx:25`） |

## 1.3 读出来的问题

1. **两本账、三个 id。** 同一轮会话发送同时写 H1 与 H3，各自 fsync，各自恢复；H3 的恢复读不到 H1，所以把可证明的 not_sent 记成 unknown。设备 run 还有台账 id 与 canonical id 两套（H2 的 `bound`）。
2. **幂等只在内存。** H5、H7 的去重和 H6 的交接都不过重启。PLAN 的「重复命令 id 返回同一回执」今天只对 H1 的 intent 成立。
3. **重启即全量重读。** H9 的 `epoch` 绑定进程；H12 全部现算。客户端无法从断点继续。
4. **派发栅栏已经存在。** H1 在调用执行器前先持久化 `run_dispatched`（`remote-dispatcher.ts:68-80`），这正是 outbox「先领取后执行」的语义，可直接迁移。
5. **轮询还在四处。** H12 的 1 s tick、C2 的 800 ms、C3 的 15 s 兜底与双往返、C4 的 250 ms–5 s 读循环。
6. **质量标记没有随用量走。** H2 的 `result` 标记带 `tokensIn/tokensOut/costUsd`，但没有 `status`/`quality`/来源（`remote-run-binding.ts:196`）；`run-output-log.ts:7-9` 却称它是 exact 用量的权威。P4 不沿用这条路（§3.3），P4-6 删掉数字并改正这段注释。
7. **SQLite 是「可降级」的。** H11 的连接失败时整体 no-op，适合统计，不适合权威（决定 A）。它的 WAL 用 better-sqlite3 的默认 `synchronous=NORMAL`（`db-connection.ts:48-49` 只设了 WAL 与 `secure_delete`，见 plan §8.2）。
8. **三种 run id。** `remote-run-…`、`run-…`、会话 turn 的 UUID（`daemon-run-evidence.ts:19-22`）；设备 run 另有台账 UUID。见 core §2.7。
