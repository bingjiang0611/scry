# Scry 无界面引擎：证据数据平面与客户端

**状态：条件性架构附录，尚未实现；P0/P1 不创建 journal/spool 或迁移 DB。** 本文属于[完整方案总览](../headless-execution-engine-design.md)。先执行 [首个切片](first-slice.md) 的观测与止损；本篇只在对应瓶颈/恢复需求成立后评估。

第 7–9 节：journal/spool、清理与删除、数据库 worker、历史查询、renderer 与远程消费。 章节编号跨文档保持一致；文中的 § 引用可按总览导航定位。

导航：[运行时与协议](runtime-and-protocol.md) · [数据与客户端](data-and-consumers.md) · [恢复与验收](recovery-and-validation.md)。

## 7. App journal、内容与证据提交

### 7.0 进入条件与写放大预算

先证明真实 raw 积压及恢复缺口，再考虑 journal/spool。只需要显式变更版本不意味着需要持久化 mutation log；低成本的索引和通知不依赖本节。

以固定输入总字节 `B` 和固定最终 canonical 证据为口径，分别记录基线/候选的下列量。不能把不同职责的副本一律当浪费，也不能简单声称恒定写入 `6 × B`：

| 写入面 | 需估算/实测的量 | 何时会发生 |
| --- | --- | --- |
| 新 journal | metadata、内联正文、checkpoint、分段头与同步次数 | 仅候选启用；明确是否与 spool 重复保存 raw |
| 新 spool | 正文、临时文件与迁移/复制字节 | 仅大内容或慢盘压力路径；必须统计最终转存成本 |
| App archive/content | serialised bytes、已有 blob 校验读取、同步 | 当前已有基线，不冒充新优化 |
| `.scry` records/content | recorder mode 下实际写入与独立校验 | disabled 记不适用；不删除副本来制造收益 |
| DB/WAL/checkpoint | 数据页/WAL/检查点写入、事务与排队 | 同时计入 DB worker 和最终 checkpoint |
| outbox | 失败时写入、重放读取及清理 | 必须测正常与故障两种负载 |

`W = W_journal + W_spool + W_app + W_recorder + W_db + W_outbox`；报告 `W/B` 和候选相对基线的增量、峰值磁盘占用、hash/编码字节及同步延迟。这里 W 是可观测进程文件写入，不冒充 SSD 物理写放大。尚未测得的格填 unavailable，不虚构节省比例。

若固定 workload 的总 CPU/写入/终态延迟变差，先解释新增恢复工作是否确有需求；无相应需求则不建 journal。group commit 降低同步次数也必须计入等待和崩溃窗口，不能提前发 durable ACK。

### 7.1 存储布局（条件性拟新增）

```text
userData/
  engine/
    runtime/          ownership、endpoint discovery、私有连接能力
    journal/v1/
      receipts/       输入收据、dispatch fence、未确定结果
      runs/<run-id>/  分段 mutation log、校验信息、checkpoint
    spool/            尚未进入 canonical content roots 的临时大内容
    projections/      可重建的页索引/摘要及其来源水位
  ...既有 App archive / DB / content roots...
workspace/.scry/records/  保持既有 canonical 一轮一文件
```

运行时 ID 不能直接来自任意客户端路径。所有路径在 engine 内从已校验身份生成；不提供按任意绝对路径读取 spool/journal 的接口。

### 7.2 耐久性口径与写入顺序

本方案不承诺跨文件系统/硬件的绝对断电安全。需要区分：进程崩溃可恢复、文件/目录提交顺序、OS/设备 flush 语义，以及实际电源故障验证。

评审中的“Node 不暴露 F_FULLFSYNC，因此只能调用普通 fsync”并不准确。已核对 Node `v24.18.0` 的 [FSync 入口](https://github.com/nodejs/node/blob/v24.18.0/src/node_file.cc#L1569-L1588) 和该版本所带 [libuv 实现](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/unix/fs.c#L170-L190)：macOS 优先调用 `F_FULLFSYNC`，失败后尝试 `F_BARRIERFSYNC`，再回退 `fsync`。这是固定版本源码证据，不是当前安装 App、所有 Node 版本或实际磁盘耐久性的实测。

Node API 成功不说明采用了哪一级回退，也不证明设备正确履行 flush。未来实验记录实际 Electron/Node/libuv、文件系统/设备和屏障延迟；正式默认承诺限定为**经验证的进程崩溃恢复与可说明的存储同步顺序，电源/OS 崩溃保护依赖平台，未做故障验证则明确未验证**。需要更强承诺时再决定平台验证/实现，不因误读 Node 源码立刻增加 native addon。

SQLite 使用独立 native 同步路径，不能继承 Node 文件同步结论。P3 要读取实际 `journal_mode`、`synchronous`、`fullfsync`、`checkpoint_fullfsync`，结合 [SQLite fullfsync 合同](https://www.sqlite.org/pragma.html#pragma_fullfsync) 和 WAL/checkpoint 行为实测；不在此预先打开选项或估计延迟提升倍数。

以下写入与回收规则均受上述口径限制：

- mutation log 采用带版本、长度、校验和的分段记录；长度先校验再分配，尾部半条记录不当作完整事实。
- 大内容先写临时 spool，验证内容摘要并达到必要文件/目录同步，再写指向它的 durable mutation。正文引用不能领先于对应内容的耐久性。
- 小型变更可 group commit，但收据、dispatch fence、checkpoint 和终态 barrier 必须等待明确的同步屏障。group commit 可以降低 fsync 次数，不能提前发送 durable ACK。
- decoder 到 durable 之间的实时尾部仍可能因进程/机器崩溃丢失。恢复报告 partial/unknown，并尝试已有可信原始来源；不能宣称 journal 从源头保证零丢失。
- App 与 `.scry` 内容根仍通过已有独立校验与原子发布写入。复用编码/摘要，不默认跨根 hardlink；现有内容读取检查及独立 CLI 可移植性保留。
- checkpoint 通过临时文件、同步和原子替换发布；任何 checksum、schema 或来源身份失败拒绝推进水位。

### 7.3 背压与磁盘满

持久化队列、实时投递镜像、worker 队列分别计数。投递镜像可 reset，不表示持久化队列也可以丢弃。

1. 接近软上限先停止新任务/非必要预热与后台扫描。
2. 支持安全背压的 adapter 才暂停相应数据读取；必须证明不会阻断同一 transport 上的审批/停止控制。
3. 不支持安全暂停时使用有容量的 durable spool。不能声称有限内存、有限磁盘能承载无限生产速度。
4. 磁盘满/写入失败时，标记 recording failure，停止新准入，按当前 recorder 失败合同暴露错误；控制面仍尝试停止和查询。
5. 不自动杀死共享 transport，不清理未收敛证据来腾空间，不把观测失败改成允许未授权执行。

### 7.4 清理与压缩

只有以下条件同时满足，才允许回收某轮的恢复日志/临时 spool：

- 按该轮开始时固定、可恢复的 recording mode 确认必需产物集合。App archive 完成；recorder enabled 时另需 `.scry` canonical 完成。合法 disabled 模式明确为“不适用”，不等待不存在的记录，也不伪造 `.scry` 成功。
- 必需内容引用已独立可读；没有 queued/reserved、未确定操作或未完成删除事务依赖该记录。
- DB 已原子提交对应投影与水位；或另有满足本方案文件及目录同步屏障的、完整可恢复的投影输入。不能删除最后一份恢复来源。

当前 [DB outbox](../../../src/main/db.ts) 对临时文件同步后 rename，但没有父目录同步，且没有输入 revision。它提供既有恢复机制，**不直接满足本方案新增文件/目录提交顺序与版本合同下的回收前提**。若后续实施 P2/P3，必须补齐这些屏障，或保留新 journal 中的完整输入；在此之前不能仅凭旧 outbox 存在就删除 journal。父目录同步也不自动升级为绝对断电保证。

慢客户端不能无限阻止 journal 清理；超出保留窗口后使用 canonical snapshot reset。未收敛、未知或损坏记录单独保护。磁盘预算到达后暂停新工作并显示清理需求，不删除它们。

journal 不承担无限保留每个 UI 中间版本的职责；清理前验证最终 canonical 事实包含现有合同要求的原始证据。若某 mutation 是唯一事实来源，则不能按普通投递日志删除。

### 7.5 会话删除与恢复互斥

扩展现有 [删除协调入口](../../../src/main/bootstrap/session-deletion.ts) 与 [跨存储删除](../../../src/main/session-deletion.ts)，不建立独立后台删除通道：

1. 删除与该 scope 的准入、dispatch、投影提交和 recovery 串行化。存在 queued/reserved、活动或结果未知的关联操作时先拒绝删除并列明阻碍；不隐式取消或丢弃任务。
2. 校验归属及共享引用后，持久化删除 barrier/generation，禁止旧 job、enrichment、cursor 和恢复任务重新写回该会话。重启先恢复删除 barrier，再恢复普通任务。
3. 将对应 journal、spool、含输入正文的收据、query/projection cache 与内容引用纳入既有删除计划。共享 App 内容只有没有其他授权引用时才回收；内容能力立即按删除状态失效。
4. 先处理可重新生成数据的恢复源，再按既有顺序删除其他 App 文件、DB 与 catalog。任何失败返回 partial_failure，保留删除重试句柄，不报全部删除成功。
5. 为避免旧写请求重放，仅保留无正文的最小防重 tombstone；保留项和原因纳入删除结果。待关联 namespace 到期、恢复源/job 全部消除且不存在晚到写入可能后，才可回收 tombstone。
6. 工作区 `.scry` canonical evidence、Provider 原生历史和无法归属的账单聚合继续按现有合同保留。删除 App 副本不意味着物理安全擦除或删除 Provider 原件；不能通过后台 recovery 静默收编回来。

## 8. SQLite、历史与查询平面

### 8.1 SQLite worker

仅在 P0 证明 DB 阻塞/资源成本后进入。先盘点同步语义并迁移连接所有权，再优化 SQL；不同时改业务表结构、定价/用量算法和线程布局。用于幂等的最小投影元数据表是新增版本化 schema，需独立迁移测试与回滚兼容记录，不能声称 DB schema 完全不变。

基线 `db.ts` 的 8 个生产直接调用模块如下；这是起始面，不含所有类型传播和间接调用，不能按“改一个 recordTurn”估算：

| 模块 | 当前依赖 | 异步化前要证明 |
| --- | --- | --- |
| [bootstrap/run-live-state.ts](../../../src/main/bootstrap/run-live-state.ts) | 同步 `recordTurn` 布尔结果后发 dataUpdated | 通知不领先于真正提交；终态与退出路径正确等待 |
| [bootstrap/agent-runtime-ipc.ts](../../../src/main/bootstrap/agent-runtime-ipc.ts) | stats/usage/billing/fixture 与 syncBillingAdmin | IPC 返回、错误/unavailable、读写互斥和权限 wrapper 不退化 |
| [bootstrap/conversation.ts](../../../src/main/bootstrap/conversation.ts) | `resolveSessionRunIds` 及同步函数类型 | 归属/删除计算不因 await 释放错误的 admission |
| [bootstrap/session-deletion.ts](../../../src/main/bootstrap/session-deletion.ts) | run IDs、outbox rows、deleteSessionData | recovery/delete 栅栏与 partial failure 顺序保持 |
| [bootstrap/remote-host.ts](../../../src/main/bootstrap/remote-host.ts) | usageAnalyticsWithCreditsQuery | 远程取消/超时与数据水位不混淆 |
| [index.ts](../../../src/main/index.ts) | resolveSessionRunIds 依赖注入 | 调用合同一致，不遗留旧同步旁路 |
| [bootstrap/startup-recovery.ts](../../../src/main/bootstrap/startup-recovery.ts) | replayDatabaseTurnOutbox | 完成重放/冲突判断前不提前开放依赖路径 |
| [bootstrap/app-lifecycle.ts](../../../src/main/bootstrap/app-lifecycle.ts) | initDb、setBillingEnvProvider | 启动 ready、降级与间接终态写入/退出 deadline 的先后关系 |

`statsQuery`、`usageAnalyticsQuery`、`billingStateQuery`、outbox 管理及删除也在迁移面。退出路径是否依赖同步完成要沿 lifecycle → run settlement → persistRunData 验证，不能凭 import 统计断言已全部覆盖。

- 所有写、查询、迁移和 outbox replay 由同一个 worker 完成。main 不保留同步查询作为 fallback。
- job 使用 run/revision/来源引用；必须 clone 全文时计入传输与峰值，不拿 worker 隐藏成本。
- 复用 prepared statement；按原事务范围提交 canonical usage、span 与 billing 投影，保留去除 shadow 双计逻辑。
- 对 `(runId, projectionKind)` 保存明确的 source generation、applied revision 和 input digest。在**同一 SQLite 事务**内检查版本、应用业务投影并提交水位；事务外不单独推进水位。
- 相同 revision/digest 是幂等重放；相同 revision 不同 digest 是冲突；更旧 revision 不能覆盖新投影。增量 job 出现缺口必须补齐前序，只有带权威完整快照及明确 supersession 证据的 job 才可跳到更新版本。
- 旧 outbox 没有 revision。启用新队列前，在单 writer 下完成显式导入：核对 canonical 来源/权威顺序，冻结来源快照并记录导入 generation。不能按 mtime 猜新旧，不能把无法判定先后的旧 args 混入新队列覆盖新 usage；冲突保留并报不可恢复的具体阻碍。
- worker 提交后才确认 projection 水位；确认丢失时查同一事务中的水位/摘要后处理，不重放 Provider 输入。
- worker 崩溃：新 journal 或满足 §7.4 屏障的 outbox 保留 job，确认旧 writer 退出后重建。DB unavailable 时返回既有明确错误状态，不返回空结果或零费用。
- 慢查询可取消/超时，但写事务结果未知时先检查提交记录，不能重新执行非幂等操作。

### 8.2 历史、目录与 Git

- 元数据、摘要与正文分离；查询请求携带 page cursor、来源 revision 和字节预算。
- 只解析当前页需要的正文；将大文件解析与索引维护放到有界 query worker。
- Pi/Claude/Qoder 等仍使用各自 source/ancestry 合同。不能把外部 native transcript 假设为可靠 append-only 文件。
- 初期保留现有全文指纹/成员验证，即使移到 worker 后仍是线性工作；指标如实记录。
- 后续只有建立可靠的 App-owned revision 或独立验证的源合同，才减少重复验证。watcher 只失效缓存，不授予读取权限或证明完整性。
- 宽目录分页可使用有界扫描快照，但选中文件/目录仍实时 canonical 校验；stale cursor 返回明确失效，不混合两次扫描。
- Git 结果按已验证 tree pair/revision 复用。保留前后 revision 检查、隔离 index、过滤器策略、未跟踪文件、超时与清理。
- 本方案不直接切换 libgit2。只有与当前 Git oracle 的补丁/权限等价及完整工作量对照成立，才评估替换。

## 9. 客户端投影与远程网关

### 9.1 Renderer

- 保留 typed `window.scry` 与 `contextIsolation/nodeIntegration/sandbox` 原值。
- 用版本化 run/turn store 替代依赖整份数组身份的高成本消费端；不全量迁移所有 UI 状态。
- Overview 复用每轮不可变贡献。修正事件必须先撤销旧贡献再加入新贡献；测试 canonical/shadow、partial、缺失用量与替换正文。
- 历史驻留窗口按字节与页数淘汰已完成正文；全会话统计有独立来源与覆盖标记，不能因只加载 40 轮就显示为全部统计。
- 选区、焦点、未回答问题、展开中的工具与脏编辑状态可固定驻留；固定内容超过预算时诚实显示压力，不能为了达标丢状态。
- 卸载冷面板不停止终端，不丢草稿；终端缓冲也需沿用既有有界策略。

### 9.2 本机与远程复用同一投影

- engine mutation 直接给出 changed revision，远程宿主不再扫描全文找变化。
- 投影的身份包含 run、revision、授权内容范围与能力版本；同一 digest 不能绕过 workspace/peer 授权共享全文。
- initial/reset 走有界 manifest 和分块页面，不先构造一份超大响应再切片。
- 网关先保留现有 poll 外部协议，内部消费 engine stream；之后再独立发布远程订阅能力。
- 旧宿主/客户端缺能力时使用其已支持的 bounded 合同或 unavailable，不新增绕过权限的兼容路径。
- 撤权后关闭对应订阅并失效内容引用；慢 peer 的信用窗口不拖住本机控制或权威持久化。
- 断线不重发 unknown input；stop reply 只表示请求处理状态，进程退出仍需独立证据。
