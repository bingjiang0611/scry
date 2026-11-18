# P4 · §7 依赖 · §8 性能 · §9 迁移 · §10 测试 · §11 决定 · §12 矛盾

属于 [P4 设计](P4-orchestration-design.md)。行号以 `72c83932` 为准。

## 7. 依赖与顺序

| 关系 | 现状 | 建议 |
|---|---|---|
| S3（删除进程内路径） | 打包构建自 main `c35d0191` 默认走 daemon；开发构建与测试实例仍默认进程内，`SCRY_HOST_DAEMON=0` 可切回（`daemon-mode-default.ts:1-8`）。S3 未做 | **S3 先于 P4-2**（决定 D）。只要进程内路径还在，日志成为权威后每条命令要有两份实现：进程内的 main 会直接写 H1、H3，App 还有自己的回执（`agent-runtime-ipc.ts:56`）；而 S3 的静态检查本来就要禁止 main 加载 `better-sqlite3`。P4-0、P4-1 只在 daemon 内、只做影子写，可与 S3 并行 |
| 两本账合并 | STATUS-BATCH4：「B4-S 之后再议」 | P4-2 合并 run 与 turn 投递生命周期；会话元数据、绑定、删除、分支仍归 `ConversationStore`（决定 G）。不单独先做一次合并，那会是要扔掉的工作 |
| P5 | 第 1 步登录时启动、第 2 步命令行批准；不改协议版本（[P5-host-cli](P5-host-cli.md) §5） | P4 占用协议 v3（§5.7）。配对与 grant 不进日志权威；P5 若采纳独立审计文件（[P5-headless-host](P5-headless-host.md) 决定 4），其「批准方式」（`via`: `app` / `host_cli`）以后作为 `device.*` 事件的证据引用 `pairing-audit:<offset>`，不另造字段。P5 的无界面运行反而受益：手机订阅不依赖 App 在线 |
| macOS 真机验证（默认打开的 daemon） | S0 于 `5363521` 收口（[b4-s0-final](status/b4-s0-final.md)）；`c35d0191` 之后的默认打开构建按任务说明仍待 macOS 真机复核 | P4-2 之前要有这份证据。P4 改变 run 的权威存储，回归时需要一个已知良好的基线 |

## 8. 性能

### 8.1 目标（提案，按 S1 的做法由数据确认后批准）

| 指标 | 目标 | 怎么测 |
|---|---|---|
| 打开已缓存会话的首屏 | 一次请求（超过 512 KiB 时加分块续读）；daemon 模式 P50 不高于当前 daemon 模式 | `scripts/session-open-bench.mjs <场景> --daemon`，四个场景；记录往返次数与字节 |
| 事件提交延迟（决策 + 事务 + fsync） | P50 ≤ 2 ms、P95 ≤ 10 ms（提案） | P4-1 影子写时在 daemon 内计时，macOS 与 Linux 各两轮 |
| 首 token | 不放宽 [P3-s1-absolute-cap](P3-s1-absolute-cap.md)：热启动两轮 P95 ≤ 200 ms、P50 ≤ 150 ms。启动路径上多出两次提交（intent、领取），预计 < 5 ms；预分配 canonical id 省掉绑定等待（§2.4） | `scripts/daemon-mode-timing.mjs`，计时锁下串行 |
| 空闲 RPC | 每客户端空闲 60 s 内个位数 | 远程请求计时（`remote-request-timing.ts`） |
| 变化到达 | 提交后 ≤ 250 ms 到客户端（本机），无 tick | 真实 daemon socket 测试 |
| 每 run 事件数与写入 | ≤ 12 事件、≤ 12 次事务（paced 20 段） | 计数器 |

### 8.2 门禁与登记

- `scripts/performance-budgets.json`、`performance-paths.json`、`performance-ratchet.json` 永不放宽。
- 订阅路径与 EventSink 登记进 `performance-paths.json` 的 `sources`，未登记则 `performance-feedback.test.ts` 失败；相关场景：`history.page`、`trace.delivery`、`remote.loopback`、`navigation.catalog`。
- 毫秒数据按 AGENTS「快速迭代」：计时锁、记录负载、负载/核 > 0.5 作废重测。

### 8.3 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 进度事件的写放大 | 按文本增量记事件，一轮会有数百次事务 | 只记生命周期转折（§4.6），输出前进只发提示 |
| 事件循环阻塞 | better-sqlite3 同步；统计库的大事务（`recordTurn`）与编排在同一线程 | 测量提交延迟的 P95；统计写入已有文件 outbox（`db-outbox.ts`），必要时按批让出 |
| WAL 检查点停顿 | 长读事务会拖住检查点 | 快照读是短同步读；监控 WAL 大小 |
| 侧栏规模 | 今天每次 `sessionsPage` 对每个 cwd 做一次 realpath（`host-runtime.ts:176-181`） | canonical cwd 在写入时固定（§2.2），读取只走索引 |

## 9. 迁移

| 段 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| P4-0 | 纯决策器（抽出 H1 的转移表）、表结构与迁移列表、EventSink、策略表；临时库单测；Recorder Core 导入测试 | 1 周 | — |
| P4-1 | 影子写：daemon 在 H1 `#emit`、H3 `settle` 处同时提交事件与 projection，测试比对；测提交延迟。`SCRY_ORCHESTRATION=shadow`，只在 daemon 读 | 1 周 | P4-0 |
| P4-2 | 日志成为 run 与 turn 的权威：submit、send、stop、answer 进命令；`remote-dispatcher` 变为 `provider.run.start` 的执行器；启动时导入 H1（`dispatched` → `failed(host_restarted)`，`recorded` → `pending`）；H1 文件改为由日志镜像写出，供回退 | 2 周 | S3、macOS 真机基线 |
| P4-3 | 本机订阅：App 切换（§6 第 1 行） | 1 周 | P4-2 |
| P4-4 | 会话目录与详情 projection；导入 `app-sessions.json` 元数据（决定 E）；首屏快照；renderer 读 projection | 1.5 周 | P4-3 |
| P4-5 | 远程协议 v3：Desktop、iOS；删除旧 op 与 renderer 读循环 | 1.5 周 | P4-4 |
| P4-6 | 清理：删除 H1 文件与镜像、`CommandReceipts`、`AppEventFeed` 的持久类、`result` 标记里的数字 | 0.5 周 | P4-5 |

合计约 8.5 周，不含 S3。

**开关与回退。** `SCRY_ORCHESTRATION=off|shadow|on` 只由 daemon 读，存在于 P4-1 到 P4-5 之间。P4-2 到 P4-4 期间，日志为权威、H1 文件由日志镜像写出，所以切回 `off` 后旧路径仍有完整台账（期间新增的会话行已回写 `app-sessions.json`，§4.4）。P4-5 升协议之后不再有开关，回退只能是回到之前的构建；旧构建不认识编排库，`migrateDatabase` 遇到更高的 `user_version` 不做任何事（`db-migrations.ts:41-42`），H1 文件在 P4-6 之前仍可用。

**旧会话（重新评估 PLAN「P4 只对新会话生效」）。** 照原样做，侧栏要同时读 projection 与旧目录，客户端又要自己拼，违背「客户端不自己拼顺序」。建议（决定 E）：P4-4 一次性导入 `app-sessions.json` 的会话元数据为 `session.imported`（证据引用文件哈希），侧栏只读 projection；**不导入** turn 正文。旧会话详情的 `detail` 快照带 `legacyBefore: true`，宿主在同一回答里附上旧只读路径的首页，客户端不合并。旧会话里新发生的 turn 正常进 projection。

## 10. 测试

| 类别 | 断言 | 级别 |
|---|---|---|
| 幂等重放 | 同 `commandId` 同载荷：一组事件、一行 outbox、一次 Provider 调用（fake provider 计数）、相同回执；不同载荷：`command_payload_conflict`；回答丢失后重试拿到原回执；daemon 重启后重试仍是原回执 | CI |
| 提交与副作用之间崩溃 | 领取前崩溃：按决定 B；领取后崩溃：`voided` + `failed(host_restarted)`，Provider 调用次数不变；会话 run：`conversation_start_unavailable`，turn 记为 `not_sent`（今天是 `unknown`） | CI，真实 daemon 进程 + SIGKILL |
| 乱序与重置 | 旧 cursor 补发；`logId` 不同、cursor 超前、低于 `pruned_through`、缺口超 128 条或 256 KB 都回快照；不认识的类型触发快照；两条 lane 并发命令按 seq 串行 | CI |
| 证据可追溯 | 每个 `run.finalized` 的引用都能解析到存在的字节且哈希一致；解析不到的必须是 `unavailable` + 原因；事件里没有用量数字；projection 空值不显示为 0 | CI |
| projection 一致 | 保留期内从空 projection 重放全部事件，结果与在线 projection 逐字段相同（含 `rev_seq`）；随机命令序列的性质测试 | CI |
| 轮询已删除 | 空闲 60 s RPC 个位数；静态检查：`LIVE_RUNS_TICK_MS`、renderer 远程读循环、iOS 800 ms 回退不存在 | CI |
| 授权 | 撤销后下一次唤醒失败；remote scope 看不到项目根外的行与本机字段；本机 op 在网络端点 `unsupported_op` | CI |
| Recorder 独立 | `src/core/turn-recorder` 不导入 `better-sqlite3` 与编排模块 | CI |
| 控制实验 | 去掉「领取先于执行」、去掉回执查询、去掉 cwd 授权，各自让对应测试失败 | CI |
| 真机 | macOS：SIGKILL daemon 于运行中、App 重启接回、v2 手机连 v3 宿主的提示、打包产物（`better-sqlite3` 解包）、中文系统语言 + 中文工作区路径。Linux：Ubuntu runner 的打包 smoke；Arch/Hyprland 目标机缺失则标 not-run | **L3，需真机** |

## 11. 需要维护者决定

旧合同 §11 的 6 条：决定 3 的库已由代码回答（`better-sqlite3@12.11.1`），但引出 A；4、5、6 按建议不再待决（§6、§5.4、§4.5）；1、2 并入下表的说明。

| # | 决定 | 建议 | 取舍 |
|---|---|---|---|
| A | 编排表放进现有 `scry.db`（PLAN 已定），还是同库同迁移函数、**单独一个文件** `orchestration.db` | **单独文件**，打开失败时 daemon 拒绝接收命令（fail closed），不像 `scry.db` 那样降级 | 同文件：符合 PLAN、一条迁移链；但 `initDb` 失败会让 run 权威一起消失，统计库的修复迁移（V16）也会挡住 run。单文件：两条迁移链、两个 WAL |
| B | 已记录、从未被领取的 `provider.run.start`，重启后派发一次（Scry 现状），还是一律作废（t3code） | **保留现状**，作为唯一显式例外；领取先于执行保证它从未开始。会话 run 例外的例外：交接内容在内存，照旧失败 | 作废更保守，但设备已收到 `recorded`，作废等于改变已承诺的行为；派发可能在宿主停机很久后才发生 |
| C | 事件保留期 | **30 天**；回执 30 天 | t3code 1 天。按每轮约 10 条、每条约 300 B，每天 100 轮约 0.3 MB/天；更长保留便于重建与排查，代价是磁盘 |
| D | S3 是否先于 P4-2 | **是**；P4-0、P4-1 并行 | 不先做 S3，就要在 main 里第二次实现命令与回执，或在 P4 期间禁止 `SCRY_HOST_DAEMON=0` |
| E | 旧会话 | **导入元数据，不导入 turn**（§9） | 维持 PLAN 原样：侧栏两源，客户端拼接 |
| F | 协议版本 | **P4 占用 v3，只升一次**（P4-5）；同时修正 iOS 的 `info.protocol == 1` | 分多次升：每次都要手机与宿主同批更新 |
| G | 两本账合并的范围 | **P4-2 只合并 run 与 turn 投递生命周期**；`ConversationStore` 保留元数据、绑定、删除、分支 | 全部合并：概念最干净，但删除、分支、侧聊各自有两阶段持久化，P4 的规模会再加 2–3 周 |

旧决定 1（`SessionLedger` 演进还是新建）：按 A 与 §2.1，新建 Orchestrator + EventSink，复用 `SessionLedger` 的转移表与重复检测，文件存储退役；`LedgerStore` 接口只覆盖追加，容纳不了同一事务里的 projection 与 outbox。旧决定 2（进度粒度）：只记生命周期（§4.6），按 REVIEW-BATCH1 的建议。若维护者不同意，在对应决定里说明即可。

## 12. 与 PLAN、旧合同、任务说明的矛盾

1. **库的「可降级」与权威不兼容。** PLAN 已定「放进现有 App SQLite」；现有连接失败即 no-op（`db-connection.ts:55-61`）。见 A。
2. **B4-S 决定与 main 不一致。** [P3-b4s-plan](P3-b4s-plan.md) 2026-11-12 决定「一步到位、不留逃生开关」；`c35d0191` 默认打开但保留 `SCRY_HOST_DAEMON=0`，开发与测试默认进程内，S3 未做。文档没有记录这次改变。
3. **证据标记是两个维度。** 旧合同把 `partial` 放进 `quality`；代码与 GLOSSARY 中 `status` 与 `quality` 分开（`turn-record-contracts.ts:8-9`）。
4. **lane 数。** PLAN 写 4 条；代码 8 条（`desktop-lane.ts:41`）。
5. **用量的「权威」没有质量标记。** `run-output-log.ts:7-9` 称台账 `result` 标记是 exact 用量权威，但标记没有 `status`/`quality`/来源（`remote-run-binding.ts:196`）。
6. **iOS 的 info 版本检查。** 宿主回 2，iOS 要 1（§5.7）。读码结论，未真机验证。
7. **P5 的「批准方式」不在 grant 上。** 任务说明称 P5 给 grant 加字段；P5 实际建议 grant 格式不动，另写 `pairing-audit.jsonl` 的 `via`（[P5-host-cli](P5-host-cli.md) §3.7），且该项仍是 P5 的待决定 4。
8. **「首屏由快照一次返回」。** 内容不进事件，快照必须捎带内容通道的首页；超过 512 KiB 需要分块续读。
9. **重启后派发与不变量 4。** PLAN「宿主侧丢失进程的副作用作废，不重放」；现有代码重启后派发「已记录未派发」的 intent（`host-controller-surface.ts:107-116`）。两者不冲突（从未开始），但 t3code 选择作废，需显式确认（B）。
10. **工期。** PLAN 5–6 周；本文估 8.5 周，不含 S3。
11. **旧合同的位置。** 旧合同范围写 `src/main/remote/`、Electron main；现在权威在 daemon，代码仍多在 `src/main/**` 但由 `src/daemon/host-process.ts` 装配。

## 13. 建议的术语（未改 GLOSSARY）

概念确认后在实现提交里补：**编排事件**（宿主决定的已发生事实，只引用证据）、**命令回执**（同一命令 id 的唯一结果）、**投影**（由事件维护、供读取的当前状态）、**副作用请求**（提交后才执行的外部动作，分进程绑定与可重放）、**订阅游标**（`logId` + `seq`）、**易失提示**（不进日志、可丢的唤醒）。
