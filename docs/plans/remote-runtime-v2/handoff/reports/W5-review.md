结论：需修改（有阻塞问题；「影子与台账一致」的结论目前不成立）

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
