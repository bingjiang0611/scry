# P4 · §7 依赖 · §8 性能 · §9 迁移与工期 · §10 测试

属于 [P4 设计](P4-orchestration-design.md)。行号说明见总体设计开头。决定、评审核对与术语（原 §11–§13）在 2026-11-18 移到 [P4-orchestration-decisions](P4-orchestration-decisions.md)。

## 7. 依赖与顺序

| 关系 | 现状 | 结论（2026-11-18） |
|---|---|---|
| S3（删除进程内路径） | 打包构建自 main `c35d0191` 默认走 daemon；开发构建与测试实例仍默认进程内，`SCRY_HOST_DAEMON=0` 可切回（`daemon-mode-default.ts:1-9`）。S3 未做 | **S3 只需先于删除 `off` 路径**，即 P4-5b 与 P4-6（决定 D）。进程内路径就是今天的 `off` 实现，P4 不给它加功能，所以不存在「第二份实现」。P4-0 到 P4-4 可与 S3 并行，两个条件：off↔on 增量导入已做（§9，P4-1）；CI 有 daemon 模式作业（下一行） |
| daemon 模式 CI 作业 | CI 只有 daemon 模式的 smoke（`.github/workflows/ci.yml:374`）；单元与集成测试走进程内，`shadow`/`on` 平时不会被执行 | P4-1 加一个作业：相关测试在 `SCRY_HOST_DAEMON=1` 下各跑 `SCRY_ORCHESTRATION=shadow` 与 `on` |
| 两本账合并 | STATUS-BATCH4：「B4-S 之后再议」 | P4-2 合并 run 与 turn 投递生命周期；边界见 core §2.8（决定 G） |
| P5（无界面执行端） | 第 1 步登录时启动、第 2 步命令行批准，与 P4 分开做（[P5-headless-host](P5-headless-host.md) §10.1）；不改协议版本，加一个可协商宿主能力（[P5-host-cli](P5-host-cli.md) §5） | 配对与 grant 不进日志权威。批准方式写在 grant 的 `approvedVia` 里（P5 §10.1 第 4 条），不另设审计文件，所以首稿设想的 `pairing-audit:<offset>` 引用作废。并行时的三处冲突见下表 |
| macOS 真机基线 | S0 于 `5363521` 收口（[b4-s0-final](status/b4-s0-final.md)）；`c35d0191` 之后的默认打开构建仍待 macOS 真机复核 | P4-2 之前要有这份证据：P4 改变 run 的权威存储，回归时需要已知良好的基线 |

与 P5 并行的冲突：

| 冲突 | 规则 |
|---|---|
| `host-process.ts` 的启动顺序 | 先打开编排库并完成恢复（core §2.4），再开任何 socket。库不可用时 socket 照开，命令类 op 带原因拒绝；P5 的只读与只收紧方法（`cancel`、`revoke`、`desktop-off`）照常可用 |
| `AppEventFeed` 归属 | P4-3 缩小它，P5-5 给它加一种通知。后合入的一方适配：P5 的通知归入提示 `hostNotice`（protocol §5.3），P4-6 不删它 |
| 无人值守重启更频繁 | 正是决定 B 改写的理由（core §2.4）；启动恢复的耗时进 §8 |

## 8. 性能

### 8.1 目标（按 S1 的做法由数据确认后批准）

| 指标 | 目标 | 怎么测 |
|---|---|---|
| 打开已缓存会话的首屏 | 一次请求（超过 512 KiB 时加分块续读）；daemon 模式 P50 不高于当前 daemon 模式 | `scripts/session-open-bench.mjs <场景> --daemon`，四个场景；记录往返次数与字节 |
| **首 token 前的提交** | **次数 2**（intent+领取；admitted+dispatched，core §2.4）；**合计 P95 ≤ 8 ms（门禁）** | daemon 内计时，记录次数与合计。理由：[P3-s1-absolute-cap](P3-s1-absolute-cap.md) 的 P50 余量只有 16–22 ms（该文 :82），提交只能占一半 |
| 单次提交（决策 + 事务 + fsync） | P50 ≤ 2 ms、P95 ≤ 10 ms（记录，非门禁） | 同上，macOS 与 Linux 各两轮 |
| 首 token | 不放宽 S1：热启动两轮 P95 ≤ 200 ms、P50 ≤ 150 ms；预分配 canonical id 省掉绑定等待（core §2.7） | `scripts/daemon-mode-timing.mjs`，计时锁下串行 |
| 空闲 RPC | 每客户端空闲 60 s 内个位数 | 远程请求计时（`remote-request-timing.ts`） |
| 本机变化到达 | 提交后个位数到十几 ms 到达 App，无 tick。首稿的 250 ms 太松 | 真实 daemon socket 测试 |
| 每 run 事件数与写入 | ≤12 事件、≤12 次事务（paced 20 段） | 计数器 |

### 8.2 每段重测与新增测量

- **每段重测**：P4-1（影子写：提交延迟，以及叠加在 H1 之上的成本）、P4-2（成为权威：首 token 与提交合计）、P4-3（本机订阅：到达延迟）各按 S1 的流程测一次：同一构建、paced fixture、计时锁、记录负载，负载/核 > 0.5 作废重测。
- **持久性成本**：`synchronous=FULL` 相对 `scry.db` 是新成本。`scry.db` 没有设 `synchronous`（`db-connection.ts:48-49`），better-sqlite3 编译时设了 `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`（依赖的 `deps/defines.gypi:16`），即 NORMAL。相对今天的 run 路径，FULL 取代 H1 每条的 fsync（`session-ledger-file.ts:139`）；只有 P4-1 影子写期间是纯叠加。
- **旧台账镜像**（P4-2 到删除 `off` 之间）在提交**之后**由可重放 effect 异步写出，不在首 token 路径上，也不是严格的回退保证（§9）。
- 另测：WAL 大小与检查点停顿（检查点期间提交的 P99）；大正文的提交（1.2 MB，data §4.7）；同一线程上 `scry.db` 的 `recordTurn` 与编排提交的 P99；远程 scope 逐行授权的成本（会话快照，行数分档）；启动恢复的耗时。

### 8.3 macOS fullfsync 与文件系统

- **事实**：Node 的 `fsyncSync` 在 macOS 上走 libuv 的 Apple 分支，发 `F_FULLFSYNC`（按 libuv 源码，未在本仓库实测），所以今天 H1 每条都刷到盘。SQLite 的 `synchronous=FULL` 在 `fullfsync` 关闭（默认）时只发普通 `fsync`。首稿「FULL 与 H1 持久性相同」在 macOS 上不成立。
- **测量**：P4-1 在维护者的 Mac 上，`PRAGMA fullfsync` 开与关各两轮，测首 token（S1 流程）与首 token 前提交合计。
- **规则**：开着仍满足 S1 两条上限，且提交合计 P95 ≤ 8 ms，就开。否则关，改设 `checkpoint_fullfsync=ON`，并在本节写明窗口：掉电（不是进程崩溃）可能丢最近几次提交。这比今天 H1 弱，测量后报维护者确认。
- **维护者决定（2026-11-19）**：P4-1 期间显式固定为 `PRAGMA fullfsync = OFF`、`PRAGMA checkpoint_fullfsync = ON`（环境变量未设置时亦然）；最终是否开启 `fullfsync` 推迟到 P4-2（待 WAL 检查点移出提交关键路径、且 H1 退出关键路径后重测再定）。首 token 前提交合计的 8 ms 门禁按绝对值计。掉电窗口说明：上述配置下，系统突然掉电（非进程崩溃）可能丢失最近几次尚未触发检查点的提交；P4-1 仅影子写，不影响权威状态。
- **Linux**：ext4 与 btrfs 都测（btrfs 的 fsync 更贵）；缺目标机标 not-run，不以 macOS 结果代替。
- **网络文件系统**：userData 在 NFS 等网络文件系统上时，打开前检测（`statfs` 类型），显示明确的 unavailable 文案：「后台服务的运行记录需要本地磁盘，当前数据目录在网络文件系统上」。不静默回退。

### 8.4 门禁与登记

- `scripts/performance-budgets.json`、`performance-paths.json`、`performance-ratchet.json` 永不放宽；「首 token 前提交合计」加进门禁。
- 订阅路径与 EventSink 登记进 `performance-paths.json` 的 `sources`，未登记则 `performance-feedback.test.ts` 失败；相关场景：`history.page`、`trace.delivery`、`remote.loopback`、`navigation.catalog`。

### 8.5 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 进度事件的写放大 | 按文本增量记事件，一轮会有数百次事务 | 只记生命周期转折（data §4.6），输出前进只发提示 |
| 事件循环阻塞 | better-sqlite3 同步；`recordTurn` 与编排在同一线程 | 测两者的 P99（§8.2）；统计写入已有文件 outbox（`db-outbox.ts`），必要时按批让出 |
| WAL 检查点停顿 | 长读事务会拖住检查点 | 快照读是短同步读；测停顿与 WAL 大小 |
| 侧栏规模 | 今天每次 `sessionsPage` 对每个 cwd 做一次 realpath（`host-runtime.ts:176-181`） | canonical cwd 在写入时固定，读取只走索引（protocol §5.5） |
| 大正文延迟落盘窗口（仅 P4-1） | P4-1 为压低首 token 前提交耗时，将 >16 KiB 外部正文文件写盘移到终态/`close()`；若进程在 `intent_recorded` 与终态间崩溃，已提交事件引用的正文文件暂未落盘，属于相对 data §4.7 的 **P4-1 专属缺口**（P4-1 影子不据此派发且 H1 持有完整正文，无运行危害） | P4-1 启动时按已解析的 H1 台账明细自动补写缺失文件（校验 SHA-256），无法补齐则计入 `missingBodies` 偏差；**P4-2 成为权威前必须关闭此缺口**（落盘先于事件引用，并与 `deleteSession` 协调延迟写回） |

## 9. 迁移与工期

| 段 | 内容 | 周 | 依赖 |
|---|---|---|---|
| P4-0 | 纯决策器（抽出 H1 转移表）、拒绝分类、表结构、独立迁移执行器（拒绝更高版本）、EventSink 与 fail closed、策略表、正文存储、单写者三层、Recorder Core 导入测试、多 Agent 预留列（core §2.10）；临时库单测 | 1.5 | — |
| P4-1 | 影子写：daemon 在 H1 `#emit`、H3 `settle` 处同时提交事件与 projection，测试比对；影子写失败只让影子 fail open，不影响 run，并计数；off↔on 增量导入与 `orch_legacy_run`；daemon 模式 CI 作业；首轮测量（含 fullfsync、ext4/btrfs） | 1.5 | P4-0 |
| P4-2 | 日志成为 run 与 turn 投递的权威：submit、send、stop、answer、`resolveIntent` 进命令；intent 与领取同事务、派发栅栏、复核、pending TTL；关闭 P4-1 大正文延迟落盘缺口（恢复 data §4.7 正文先于事件引用落盘，含 `deleteSession` 协调）；恢复查 recorder 证据；两本账对账；旧台账异步镜像；重测 | 3 | P4-1、macOS 真机基线 |
| P4-3 | 本机订阅：App 切换（§6 第 1 行）；`AppEventFeed` 缩小并接 P5 通知；重测 | 1.25 | P4-2 |
| P4-4 | 会话目录与详情 projection；导入 `app-sessions.json` 元数据（决定 E，增量）；`catalog.scan` 触发；transcript 区间引用；首屏快照；renderer 读 projection；删除会话的清除与墓碑 | 2 | P4-3 |
| P4-5a | `subscribe` 作为 v2 能力：Desktop、iOS、执行目标转发、keyset 分页、逐行授权；真机验证 | 2 | P4-4 |
| P4-5b | 升 v3，只删旧 op（宿主、Desktop、iOS、转发白名单）；删除开关 | 0.5 | P4-5a 真机通过、S3 |
| P4-6 | 清理：删除 H1 文件与镜像、`CommandReceipts`、`AppEventFeed` 的持久类、`result` 标记里的数字，改正 `run-output-log.ts:7-9` 注释 | 0.5 | P4-5b |

**合计约 12 周（11–13），不含 S3**；等维护者安装真机客户端的时间不计入。首稿 8.5 周；增加的部分：P4-2 +1 周（复核、TTL、证据恢复、两本账对账、放行停止）；P4-4 +0.5 周（扫描触发、清除与墓碑）；协议拆成 5a/5b 并加转发与真机轮 +1 周；P4-0/P4-1 各 +0.5 周（迁移执行器、正文、增量导入、CI 作业、首轮测量）；P4-3 +0.25 周。落在评审 10–12 周的上沿，主要因为协议拆两段要多一轮真机验证。

**开关与 off↔on（B4）。** `SCRY_ORCHESTRATION=off|shadow|on` 只由 daemon 读，存在于 P4-1 到 P4-5b 之间。开发构建与测试实例默认进程内（`daemon-mode-default.ts:6-9`），所以同一份 userData 在进程内与 daemon 之间来回是开发者的日常，不是罕见回退。规则：

1. 每次以 `shadow` 或 `on` 启动，都读旧台账中 seq 大于 `orch_meta.legacy_ledger_seq` 的条目，幂等导入：按 scoped intent id 查回执，按台账 run id 查 `orch_legacy_run`，已有就跳过。`off` 期间派发了却没有终态的 run 在 P4-2 权威模式记 `unavailable`（P4-1 影子模式保留 `dispatched` 交由 H1 `recover()` 同步驱动以保持一致）；只记录未派发的在 P4-2 按 core §2.4 的 pending 规则处理（多半已过期，记 `not_sent`）。**历史导入 actor 说明**：H1 落盘台账只保存已绑定 peer 的 `scopedIntentId`，未落盘原始 `peerCertSHA256`，因此历史导入的回执以 `actor='system'` 落库（实时影子与 P4-2 实时命令均写 `peer:<certSHA256>`）；P4-2 对客户端重传查询回执时按 `(command_id = scopedIntentId, actor IN (peerActor, 'system'))` 兜底历史导入项，因 `scopedIntentId` 已与 `peerCertSHA256` 密码学绑定，不会发生跨设备串号。`app-sessions.json` 的哈希与 `legacy_catalog_sha256` 不同就做同样的增量导入。当未导入历史条目超过 2,000 条时，启动前仅同步导入未终态 run，其余历史终态在 `openLocalChannel` 之后分批让出导入，避免大台账阻塞守护进程就绪。
2. `on` 期间旧台账由 `legacy.mirror` 在提交后异步写出，并推进 `legacy_ledger_seq`。崩溃后下次启动补写；补写之前切到 `off` 会少最近的 run，所以它**不是**严格的回退保证。
3. 不选「on → off 单向」：那会让 S3 之前保留的逃生开关（`SCRY_HOST_DAEMON=0`）要么拒绝启动，要么静默分叉历史。

P4-5b 之后不再有开关，回退只能回到之前的构建：旧构建不认识 `orchestration.db`，H1 文件在 P4-6 之前仍可用。

**旧会话（决定 E）。** P4-4 导入 `app-sessions.json` 的会话元数据为 `session.imported`（证据引用文件哈希），侧栏只读 projection；**不导入** turn 正文。旧会话详情的 `detail` 快照带 `legacyBefore: true`，宿主在同一回答里附上旧只读路径的首页，客户端不合并。旧会话里新发生的 turn 正常进 projection，`ordinal_origin: since_import`（data §3.2）。

## 10. 测试

| 类别 | 断言 | 级别 |
|---|---|---|
| 幂等与回执 | 同 `commandId` 同载荷：一组事件、一行 outbox、一次 Provider 调用（fake provider 计数）、相同回执；不同载荷 `command_payload_conflict`；回答丢失后重试拿原回执；daemon 重启后、事件裁剪后仍是原回执；可重试拒绝不留回执；结果命令重复投递不产生第二组事件 | CI |
| `resolveIntent` | 找不到时写墓碑；迟到的原提交得到 `command_payload_conflict`，Provider 调用 0 次 | CI |
| 派发与重启 | core §2.4 表格逐行，真实 daemon 进程 + SIGKILL：已领取未派发 → `not_sent`，Provider 0 次；已派发 → `unavailable`，有 recorder 证据时按证据收尾；pending 未过期复核后派发一次，过期或时钟回拨 → `not_sent`（`SCRY_ORCHESTRATION_PENDING_TTL_MS` 调小，记录变量与值）；intent 与派发之间撤销 grant → `grant_revoked`；开着的提问同事务关闭 | CI |
| fail closed | 注入 IOERR / FULL / fsync 失败 → fence，命令可重试拒绝，停止仍生效；损坏文件、更高 `user_version` → 拒绝打开；迁移执行器不调用 `repairMissingUsageLedger`；第二个连接因 EXCLUSIVE 失败；main 不导入编排模块（静态检查） | CI |
| 乱序与重置 | 旧 cursor 补发；`hostId`/`logId` 不同、cursor 超前、低于 `pruned_through`、扫描超界、相关事件超 128 条或 256 KB 都回快照；回答的 `seq` 是扫描位置，截断时不丢事件；不认识的类型触发快照；`logId` 变化后客户端不自动重发 `unknown`；两条 lane 并发命令按 seq 串行 | CI |
| off↔on | on → off（进程内写入 H1 与目录）→ on：增量导入一次，再启动不重复；镜像滞后时切 off 的行为与文档一致 | CI（daemon 模式作业） |
| 两本账 | 文件有 turn 无事件 → `not_sent`；事件有结论文件仍 pending → 回写；绑定不一致 → `conversation_binding_conflict` | CI |
| 证据可追溯 | 每个 `run.finalized` 的引用都能解析到存在的字节且哈希一致；transcript 区间引用在文件删除后为 `unavailable(source_removed)`；导入结局不为 `exact`；`host_restarted` 的 `settled_at` 为空；事件里没有用量数字；projection 空值不显示为 0 | CI |
| projection | 未裁剪窗口内、排除已清除会话，从空重放与在线 projection 逐字段相同（含 `rev_seq`）；随机命令序列的性质测试；schema 版本迁移改写行 | CI |
| 删除会话 | 正文文件被删、预览被擦除、projection 行消失、远程客户端收到墓碑；`scry.db` 不可用时结果为 `unavailable` | CI |
| 轮询已删除 | 空闲 60 s RPC 个位数；静态检查：`LIVE_RUNS_TICK_MS`、renderer 远程读循环、iOS 800 ms 回退不存在（P4-5b 后） | CI |
| 授权 | 撤销后下一次唤醒失败；remote scope 看不到项目根外的行与本机字段；本机 op 在网络端点 `unsupported_op`；执行目标转发只在 Mac2 声明能力时开放 `subscribe` | CI |
| Recorder 独立 | `src/core/turn-recorder` 不导入 `better-sqlite3` 与编排模块 | CI |
| 多 Agent 预留 | P4 不产生 `task.*`、`agent:` actor、`origin = 'agent'` 与会话级停止命令；`principal` 等于 actor；级联停止的后代集合为空；只对 Agent 命令生效的复核行不触发；fork 与侧聊的谱系与会话文件一致；客户端解码器忽略不认识的可选字段 | CI |
| 控制实验 | 去掉「领取先于执行」、去掉派发前复核、去掉回执查询、去掉 cwd 授权，各自让对应测试失败 | CI |
| 真机 | macOS：SIGKILL daemon 于运行中、App 重启接回、fullfsync 开关两轮测量、v2 手机在 P4-5a 用能力、v2 手机连 v3 宿主的提示、打包产物（`better-sqlite3` 解包）、中文系统语言 + 中文工作区路径。Linux：Ubuntu runner 打包 smoke；ext4 与 btrfs 测量；Arch/Hyprland 目标机缺失则标 not-run | **L3，需真机** |
