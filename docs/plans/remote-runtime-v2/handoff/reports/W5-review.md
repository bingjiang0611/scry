结论：需修改（第二轮：剩 1 项阻塞、6 项应修，见文末）

# W5（P4-1）核验（核验方，2026-11-19）

提交：`3c283ea5`、`385343f9`、`73f3ab6b`、`15ac06f2`、`f0bad0d8`（报告 `dd6a7c89`、`25b22de9`、`6a3234b9`）。

复跑（Linux）：CI 新作业的命令按 `shadow` 与 `on` 各跑一次，均 48 个文件 208 个用例通过；`host-process-orchestration-shadow.test.ts` 与 `supervisor.test.ts` 在 `SCRY_HOST_DAEMON=1 SCRY_ORCHESTRATION=shadow` 下通过。核验方另用探针复现了下面 B1–B3。

## 阻塞

- **B1 任何会话的第二轮都会让影子失效**（已复现）：影子的 submit 不带 `ordinal`（`shadow-mirror.ts:200-211`），决策器回落到 `ordinal ?? 1`（`orchestrator.ts:121`），第二轮插入 `orch_p_turn` 撞主键 `(session_key, ordinal)`（`schema.ts:87`），触发 fence，影子一直关到后台服务重启。所有测试每个会话只有一轮，所以没发现。S1 测量每轮只记到 2 次提交，很可能也只测到了单轮会话。修法：从 H1 / 会话账本带上真实 ordinal；补多轮、恢复会话的测试；修后重测。
- **B2 影子的偏差没有计数**（已复现）：`executeTimed`（`shadow-mirror.ts:168-189`）忽略 `DecisionResult`。可重试拒绝、黏性的 `illegal_transition`/`invalid_target`、sink 已 fence，都被静默丢掉，而 `commits` 照样加一、`failures` 仍为 0。启动导入触发 fence 时只记日志（`orchestration-shadow.ts:57-71`），`failedOpen` 不置位，之后每次「提交」都是无声的空操作。被拒绝的空操作还被记进提交耗时样本，污染测量。修法：按结果分类计数（成功、拒绝、fence），fence 后置 `failedOpen`，拒绝不进耗时样本；比对测试要断言偏差为 0。
- **B3 H3 settle 绕过了 EventSink**（已复现）：`onConversationTurnSettled`（`shadow-mirror.ts:410-452`）直接用 SQL 写 `orch_p_turn`，不写事件、`rev_seq=0`、用 `Date.now()`、不检查 `isWriteIndeterminate()`。违反 plan §9 P4-1 行与 data §4.4（projection 与事件同一事务）；一次 settle 后 `verifyReplayConsistency()` 就从 true 变 false。改为走 `execute` 提交对应事件。

## 应修

1. **重启时影子与 H1 的分歧被测试固化**：导入在 `createHostRuntime` 之前把关闭期间已派发的 run 记为 `interrupted`；随后 H1 的 `recover()` 把同一批记为 `failed(host_restarted)`（`host-controller-surface.ts:113-115`），`pump()` 还会派发导入已取消的 intent（`legacy-import.ts:171-191`），结果在影子库里留下永久的黏性 `illegal_transition` 回执。daemon 测试只断言影子是 `interrupted`、不看 H1（`host-process-orchestration-shadow.test.ts:99-102`），停止检查接受 3 种状态之一（`:177`）；「逐字段」比对只比了 4 个字段（`shadow-mirror.test.ts:111-123`）。影子阶段应镜像 H1 的结果而不是自己做决定，比对要覆盖全部字段。
2. **证据**：导入时 `settledAt: run.terminalAt ?? now`（`legacy-import.ts:243`）为只有快照的 run 编造了结束时间（data §3.2 第 5 条）；没有就留空并标 `unavailable`。
3. **现在写进永久数据、到 P4-2 会出问题的**：
   - 设备 intent 的回执 actor 记为 `system`（`shadow-mirror.ts:199-216`、`legacy-import.ts:136,157`），P4-2 按 `(scopedIntentId, peer:…)` 查不到，而回执永久保留（core §2.10：actor 含义写进回执就不能改）。影子阶段就用 P4-2 将使用的 actor。
   - 影子的 `provider.run.start` outbox 行永远停在 `running`/`pending`（`legacy-import.ts:148`）；标记为影子来源，保证 P4-2 的恢复不会处理它们。
   - `SCRY_ORCHESTRATION_PENDING_TTL_MS` 没有上限（`mode.ts:493-498`），还经 supervisor 转发（`supervisor.ts:113-117`）。现在就限制在 60 s 以内，否则 P4-2 时一个大值会重新派发几小时前的消息，正是决定 B 要防止的事。
   - `on` 现在映射成 `shadow`：P4-2 发布后，环境里留着 `on` 的人会静默拿到权威模式。P4-1 期间 `on` 应拒绝启动影子并提示，而不是映射。
4. **启动开销**：导入每个历史 run 约 3 个事务、各自 fsync（`legacy-import.ts:131-255`），在 `host-process.ts:307` 同步执行、早于 `openLocalChannel`（`:358`）。H1 快照最多 10 万个 run，长历史首次以影子启动时可能卡住几秒。批量提交，并测一次大台账的启动时长。
5. **性能登记**：只登记了 `event-sink.ts`（`performance-paths.json:411`）；`shadow-mirror.ts`、`projection.ts`、`src/daemon/orchestration-shadow.ts`、`src/main/conversation-store.ts` 也在热路径上，补登记。「首 token 前提交合计」门禁尚未进 `performance-budgets.json`（plan §8.4，延后不等于放宽，报告里写明）。
6. **缺负面测试**：daemon 层面 `orchestration.db` 打不开（更高版本、损坏、被锁）时 run 仍成功；多轮会话；大附件（1.2 MB 正文）；实时影子写与导入混合的往返。
7. **可选**：观察者在 `notify()` 之前执行（`host-controller-execution.ts:55-58`），watcher 唤醒要等 fsync，可调到之后；派发前对最大 1.2 MB 的 intent 正文整体 `JSON.parse`（`shadow-mirror.ts:57`）；影子库从不裁剪；App 发起的 run 也被记为 origin `remote`（`shadow-mirror.ts:209`）；CI 的 `on` 一列在 P4-2 前与 `shadow` 重复，集成测试自己设置模式，矩阵值不影响它；计时脚本按时间窗而不是 run id 归属提交标记，并把冷启动样本混进提交统计（`daemon-mode-timing.mjs:130-142`、`343-351`）。

## fullfsync 测量

方法符合 S1（n=30，28 个热样本，两轮，负载 ≤ 0.26/核，计时锁）。但：

- 报告写的「通过」掩盖了一点：fullfsync 关闭时第 2 轮 P95 也是 10.77 ms，同样超过 8 ms 门禁。两种配置都没有在两轮都达标。尾部很可能来自提交内触发的自动检查点。
- 提交耗时只计了决策加提交；S1 的 P95 增量（关：+5..13 ms；开：+22..30 ms）大于提交合计的 P95，说明提交合计低估了对首 token 的影响。
- 由于 B1，测量可能没走到多轮路径；B1 修好后需要重测。
- 环境变量未设置时 `db.ts:99-104` 两个 pragma 都不设，比测过的两种配置都弱；要显式固定。

## 需要维护者决定

见核验方给维护者的汇总：fullfsync 不在 P4-1 定，P4-1 期间先固定为「fullfsync 关、checkpoint_fullfsync 开」（只是影子，没有风险），到 P4-2 把检查点移出提交路径、H1 退出关键路径后重测再定；以及 8 ms 门禁按绝对值还是增量计。

## 复核（第二轮，2026-11-19，修复提交 `c09ec658`、`520b388b`、`637437ff`、`7eb169f0`）

复跑（Linux）：`tsc` 通过；CI 作业命令（shadow）50 个文件 234 个用例通过；台账、网关、CI 工作流、性能登记测试 124 个通过。新测试放到修复前代码上，B1/B2/B3、模式与 TTL、`settledAt` 置空、分批导入、共用转移表等均失败，证明有效。

| 项 | 结论 |
|---|---|
| B1 轮次序号 | **部分**：不再撞主键，但序号来自影子自己的 `MAX(ordinal)+1`（`shadow-mirror.ts:272`、`event-sink-statements.ts:56-58`），生产路径上 `routing.ordinal` 从不存在（`managed-launches.ts:36-44` 的明细里没有 ordinal）。核验方探针：一个先有 2 个收编轮次、再派发一轮的会话，会话账本是第 3 轮，影子记成第 1 轮，`deviations` 仍为 0；分支会话、开启影子前就存在的会话同样。settle 时若该轮不存在会按账本序号插入，可能与影子自编的序号冲突，触发 fence 后永久失效 |
| B2 计数 | 已修：分类计数，fence 置 `failedOpen`，拒绝不进耗时样本；启动导入 fence 也置位（缺测试；导入中的拒绝未计数） |
| B3 settle | 已修：走 `turn.record_delivery` 事件，重放一致 |
| 应修 1 重启分歧 | 已修 |
| 应修 2 编造结束时间 | 已修 |
| 应修 3 actor | **部分**：实时路径写真实 `peer:<certSHA256>`，App 运行为 `local`，与 core R2/R3 一致；但导入路径仍写 `system`/`remote`（`legacy-import.ts:168,175-177`，导入时拿不到 peer，报告未说明）；回答提问写 `system`（`shadow-mirror.ts:453`），`answered_by` 应为回答的 peer |
| 应修 3 outbox | **部分**：`provider.run.start` 已标 `done/shadowOnly`，但 `question.respond` 行仍是 `pending`、无 lease、无 `shadowOnly`（`orchestrator.ts:327-337`），P4-2 恢复会处理它 |
| 应修 3 TTL、`on` 拒绝 | 已修（`on` 只拒绝影子、不影响后台服务；`decide()` 内未再夹紧 TTL，可选） |
| 应修 4 启动导入 | **部分**：500 条一批正确且中断后可幂等续导（探针验证）；但只测到 2,000 条，H1 上限 10 万条外推要几十秒，仍在 `openLocalChannel` 之前同步执行 |
| 应修 5 性能登记 | 已修，漏登记新文件 `event-sink-statements.ts` |
| 应修 6 负面测试 | 已修（daemon 的「1.2 MB」实为约 1.05 MB） |
| 可选 7 | 部分：`notify()` 已提前，但它只是 resolve promise，被唤醒的 watcher 仍在同步提交之后才运行，报告「不再等 fsync」不成立 |

**测量**：冷样本已排除、提交按 run id 归属。但单轮影子那一对 P95 是 135.0 与 98.8 ms，相差 36.2 ms，超过 `P3-s1-absolute-cap.md:46` 的 25 ms 稳定性规则，**这一对作废**，需重测；多轮一对（111.7 / 112.9 ms）有效，支持「S1 上限满足」。「≤ 8 ms」只覆盖 `sink.execute`（决策加提交，P95 ≤ 3.29 ms），没覆盖解析路由、哈希、读下一序号、以及超过 16 KiB 时正文文件的写入与 fsync（`shadow-mirror.ts:274-277`），所以只能说明数据库提交部分。

**仍需修改（执行方 C）**

阻塞：
1. **B1**：真实序号要从会话账本或 H1 带进明细与影子；settle 时比较账本序号与影子序号，不一致计为偏差；补收编、分支、跨重启恢复的会话测试。

应修：
2. 所有影子 outbox 行（含 `question.respond`）标 `done/shadowOnly`。
3. 重测单轮影子那一对，并在 W5.md 写明原数据作废。
4. 计时覆盖整个影子钩子，或单独报告未覆盖部分，含大正文样本。
5. actor：导入回执写 `system` 的处理写进设计或报告；`answered_by` 记录回答的 peer。
6. 启动导入：在 10 万条规模测一次，或移到 `openLocalChannel` 之后。
7. `output_seq`：升 schema 版本，或写明删除开发用库（W4 带过来）。

可选：导入 fence 的测试与导入拒绝计数；更正报告里 `notify()` 的说法；登记 `event-sink-statements.ts`；`decide()` 内夹紧 TTL；真 1.2 MB 的 daemon 测试；影子库裁剪；网关 `#runPeers`/`#runScopes` 清理；计时脚本只归属预期 run id。
