# 2026-10-28 会话并发 P0 归因：native 测量 fixture 阶段记录

## 状态

- 本篇记录的是 P0 的**测量工具**阶段（不是优化）：[首个切片](../research/headless-execution-engine/first-slice.md) 的 P0 归因表已可生产，采集当时的缺项见下文第 6 节。**后续记录**：R6 与 50k 的 pilot、比较预注册与最终副本回放都已完成，**P0 已正式冻结**（baseline 冻结，不是改善结论；[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5）；P1 未开始。
- P1 **未开始**（P0 冻结后仍未开始）。上述采集时没有产生任何优化 commit、安装或推送；测量工具随后单独提交，不与 P1 优化混在同一提交。
- 本篇是阶段记录，不是验收门禁；性能门禁与 ratchet 仍以[性能闭环](../performance-loop.md)为准。

## 1. 这阶段做了什么

把"4/16 并发会话"从口头规格变成可重放的离线测量 fixture，只在仓库脚本内运行，不改产品运行路径：

- **并发度**：`4` 和 `16` 是唯一接受的 active 上限（`SCRY_CONCURRENCY_RUNS`）。
- **总工作量**：新增 `SCRY_CONCURRENCY_TASKS`，默认等于并发上限，只允许"等于上限"或 `16`。因此可以对照"16 任务/4 在途"与"16 任务/16 在途"：任务数固定，差别只在限制，不靠减少工作做出更快数字。
- **真实进程与真实隔离**：真实隔离的隐藏 Electron 窗口（offscreen、`--disable-gpu`）、临时 `HOME`／`userData`／每任务独立 workspace，离线 smoke Provider。**不调用任何外部 Provider 服务、不需要真实凭据**，但并非无网络：harness 仍通过 loopback CDP（HTTP/WebSocket）驱动该窗口。临时目录隔离只是为了让测量互不污染，**不是安全 sandbox**，也不改变产品原有的权限与 trust 语义。
- **fixture worker pool**：最多 `concurrency` 个 drive 在途，按任务索引归位；一次派发失败后不再派发新任务，已派发的继续收敛，剩余任务显式记 not-started（不补零、不重试）。这是测量 fixture，不是产品队列能力。
- **队列与吞吐**：排队起点、派发、终态都在同一 renderer `performance` 时钟上，报告每任务 queue wait、批次完成时间与吞吐；排队时间不被算作 accepted 并发。
- **并发重叠双指标**：`requested`（dispatch→terminal）与 `acceptedActive`（start reply→terminal）分别给出实测峰值，与配置上限对比；两者都不证明 CPU 级并行，也不证明 Provider 子进程数量。
- **磁盘证据**：live turn 与 seeded history 都从该实例真实写入的 `userData` trace 归档读回——`trace-archive-turns-v1`（live turn）与 `trace-archives-v2`（seeded history 与 monolith 副本），工具结果按引用到 `trace-content-v1` 重读原始 blob 并核对 digest／尾部标记，逐任务给出 checks，而不是只看页面回报。这里读的是 App 自己的归档与内容 blob，**不是**工作区 `.scry/records` 的 turn 事实源；本阶段没有验证 `.scry` 那一条链。
- **history 切换**：先要求**全批**任务的真实 `start` reply 与该 cwd 的新会话行都入场，之后才做 4 次原生指针点击（4 个不同初始 cwd 的 history）与 Overview 可见性校验；入场等待计入 active 时间，不额外延长阶段 deadline，UI 动作不等所有终态。
- **CPU 归因**：独立 active／quiet 两个边界对；进程 CPU 用 `CPUUsage.cumulativeCPUUsage` 跨边界差值，按 `pid` + `creationTime` 配对，新增/消失/身份缺失/计数器缺失或回退都显式列入 coverage 并降级为 partial/unavailable；进程 CPU、主进程 `cpuUsage`、renderer task time 三个 lane 互不相加；journal 窗口的 percentCPU 因采样互相干扰而标 unavailable，不伪造修正时间戳。

## 2. 明确不测量、不宣称

- 无真实 Provider（离线 smoke adapter 在进程内），因此没有 Provider 子进程 CPU、没有 TLS、没有真实网络成本。
- 无 React commit 延迟：没有可信的 per-batch commit 信号，`rendererCommit` 保持 unavailable，也不拿 useAgentSession ACK 或 DOM mutation 冒充。
- 无 GC 测量：不强制 GC，也不采集 GC 事件，GC 后驻留标 unavailable；`forced:false` 不等于观测到自然 GC。
- remote readers（0/1/4）在本阶段 native 窗口 harness 里尚未实现，lane 记 unavailable（`not yet implemented in this concurrency harness`），未宣布"不存在"。后续：in-main trace 工具已实现并采到 0/1/4，见 [in-main trace 与 remote readers 阶段记录](./20261028-concurrency-trace-readers.md)；该结论只针对本阶段 harness。
- 隐藏窗口 + `--disable-gpu`：报告的 GPU 进程 CPU 只是该配置下的进程 CPU，不等于硬件 GPU 利用率，也不等于日常硬件加速 App 的成本；没有阶段证据把它的来源归给任何具体 renderer 或 CDP 负载。
- **性能结论**：全部数据在高负载机器上取得（见第 3 节），只能作为**功能证据**，不构成 L2 改善，也不构成 P1 收益。

## 3. 证据

| 项 | 值 |
| --- | --- |
| 环境（采集时） | Node 24.18、Electron 42.10.1、App 0.2.227、arm64 Apple M2 Pro 10 核 |
| 机器负载 | 采集期间约 21.36–26.34 / 10 核（更早两组 16–28 / 10 核），全程 `highLoad=true`，只作功能证据。该判定不在 bench 报告 JSON 内，而来自同一日志末尾 `SCRY_TIMING_RUN=<json>` footer（由 timing 锁 wrapper 输出） |
| 源码 | `87c5ffcb4a730f60ee926cd97579aabe8ded10de`（上述采集时工作区为 dirty） |
| artifact（采集时） | `9095554461dd4acf3835fd4abfb8d196a04c9b449d254ef98c8c81523e4a0a27` |
| harness（采集时） | `e0ef89a1f562c60bc6aaec1e32858f51c1966079935ad45cf4e32055a232fc69` |
| unit（采集时） | 六套 89/89 通过；`npm run typecheck` 通过 |

native 采集第一批（**采集时 harness hash**）：`/tmp/scry-p0-cleanup-final.DKrPVx`

- `4` 任务：`history-switch`、`stream`、`quiet`、`big-output` 四个场景（4 任务 / 4 在途）。
- `16` 任务 / `16` 在途：`quiet`、`big-output`。
- 六个 case 均为：所有任务归档校验通过、requested/accepted 峰值符合预期、root 退出 `close code 0` 且 cleanup 确认；`history-switch` 为 4 次原生点击 + 4 次 Overview 可见。

native 采集第二批（**同一 harness hash**）：`/tmp/scry-p0-fixed16-final.m1NUYQ`——全部 `tasks=16`，覆盖 `history-switch` 与 `stream` 的 limit 4 和 limit 16、`quiet` limit 4、`big-output` limit 4，共 6 个 case，harness hash 同样为 `e0ef89a1…a232fc69`。

两组合计，采集时 harness hash 下的**正常 case 共 12 个**：4 种场景 × 3 种 `tasks`/`limit` 组合（4/4、16/4、16/16）已齐；每个 case 都是 16 个任务全部归档校验通过、16 完成并给出 queue wait、峰值等 limit、`history-switch` 为 16 入场 + 4 次原生点击 + 4 次 Overview、root 退出 `close code 0` 且 cleanup 确认。

更早的 `/tmp/scry-p0-fixed16-repaired.SEpEQt` 属于**不同 harness revision**，仅作历史对照，不与上述 12 个 case 合并计数。

提交前只做了一处机械清理：把 `session-concurrency-aggregate.mjs`、`session-concurrency-contract.mjs`、`session-concurrency-evidence.mjs` 三个文件末尾多余的空行各去掉一个，改为单个换行，其余字节不变。因此**下文 12 个原生结果引用的是清理前的 harness `e0ef89a1…a232fc69`**；清理后的文件字节 hash 未再重采，也不声称 12 个结果绑定清理后的最终 hash（预计只差这三个 EOF 换行带来的哈希变化，但没有重跑，所以不作为已测事实）。

## 4. 失败与修复（保留记录，不粉饰）

1. **fixed-16 history 第 5 个任务被拒绝**：最初只等 4 个 switch 目标入场就开始切换，浏览 history 改变了当前授权 cwd，仍在排队的任务 `start` 被真实 trust/cwd 门拒绝（"发送请求的工作目录与当前授权目录不一致"）。修法：改为**全批**入场后才允许点击，并且入场证据改用真实 `start` reply，不再把 `recordPending` 阶段渲染出的新行当作已接收——该行先于 run 注册出现，只证明意图。
2. **误删 Overview helper**：一次函数替换把 `ensureOverviewVisible` 及其常量一起删掉，`node --check` 仍通过，直到在真实隔离 Electron 测试实例里运行才以 `ReferenceError` 失败。修法：按原始观测逐字恢复该块；并新增 TypeScript `createProgram`（allowJs/checkJs/noEmit）未绑定名称检查（诊断 2304/2552/18004）＋缺失绑定的负控，而不是再靠"源码包含某字符串"。
3. **未处理的 batch 拒绝打断清理**：UI 异常后 `poolRun` 尚未 await，`session.close()` 让该 CDP 请求拒绝，形成 process 级 unhandled rejection，`finally` 的 stop/close/drain/flush 被中断，留下自建 App 进程。修法：派发即用 `trackBatch` 接住拒绝并保留原错误（正常路径再抛、失败路径只报告已 settled 的批次错误，不重试、不吞错），并补两个 Node 子进程正/负控（有保护时 cleanup marker 必达且原错误可报告；无保护时 `--unhandled-rejections=strict` 必须在 marker 前失败）。

关于第 3 条那次遗留：父会话仅重验原 root 后回收，4 个已观测 PID 均已不存在；该次 App stdout 没有保存，因此**不能**声称保留了完整日志。

受控故障注入（当前版本，`/tmp/scry-p0-cleanup-final.DKrPVx/controlled-failure.log`）：在 4 个任务已入场、pool in-flight 时抛 UI 错误 → 原错误保留、`finally` 写出 21902 字节 App 日志、随后观测到的 23 个 PID 全部不存在、retention 判定为 **run failure** 而非 cleanup unknown。未登记的后代仍是 unknown，不写 0。

## 5. 已知的报告口径限制

- `switchStartedRows` 现在记录的是**全批每任务**的入场证据（`startedRow` + `startReply`），不只是 switch 目标；字段名沿用旧名。
- 只有最后一个任务显式 focus，但生产的 legacy `start` 仍会自动聚焦自身，因此前几波可能短暂成为前台；中间帧的 renderer 工作量不固定，镜像数量/字节与最终 DOM 以观察值为准。
- 周期采样的 max 不是连续峰值；各进程峰值相加不是同一时刻的全 App 峰值；RSS/working set 求和不等于精确物理内存。
- 未观测到的东西（峰值、GC 后驻留、未登记进程）保持 unknown/unavailable，不补零。

## 6. 开放项与 owner

| 开放项 | owner | 备注 |
| --- | --- | --- |
| remote readers 0/1/4 | 父会话 | in-main trace 工具已实现并采 12 格（[续篇](./20261028-concurrency-trace-readers.md)）；本阶段的 remote fixture 当时仍待冻结。**后续记录**：R6 真实 App 受限回环 fixture 已验收并随 P0 一起冻结（[R6 篇](./20261028-concurrency-trace-live.md)、[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5） |
| 1k/10k/50k 负载、eviction/reset | 父会话 | 1k/10k × readers 0/1/4 已采；50k 耗时当时未测（**后续记录**：[main-only 50k 篇](./20261028-concurrency-trace-main-50k.md)），实际 hash 计数已由 counts-only 工具采到（[计数与试点篇](./20261028-concurrency-trace-counts-pilot.md)）；容量、旧 cursor 与逻辑时钟 sweep 有组件回归，reset 只在受控串行序下观测（[续篇](./20261028-concurrency-trace-readers.md)） |
| 噪声、MDE、重复次数与顺序预注册 | 父会话 | 预注册后才允许 L2 结论；**后续记录**：内容已定且 P0 已正式冻结（[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §4–§5），阈值与顺序未改 |
| 低负载匹配 baseline、collector 整体冻结 | 父会话 | 续篇每格各有一次 `highLoad=false` 样本，尚非稳定匹配基线或 L2 改善；冻结还需预注册噪声/MDE（[续篇](./20261028-concurrency-trace-readers.md)、[计数与试点篇](./20261028-concurrency-trace-counts-pilot.md)）；**后续记录**：预注册已定（[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §4），最终副本 `/tmp/scry-p0-accepted-baseline.zYksRe/` 已保存并回放通过，P0 已正式冻结（§5） |
| 环境负载 | 父会话检查，必要时请用户安排空闲窗口 | native 旧样本为高负载，后续 remote 样本为低负载；逐次核对，不擅自结束用户进程 |
| collector 提交 | 父会话 | 工具分阶段独立提交，不与 P1 优化混在同一提交，提交号以 Git 历史为准；整体冻结已完成（[冻结验收](./20261028-concurrency-trace-p0-freeze.md) §5） |

## 7. 复现

毫秒结论必须走既有的 timing 锁 wrapper（不要裸跑 bench 做计时比较）。可直接复制的例子——`stream`、16 任务、limit 4：

```
SCRY_CONCURRENCY_RUNS=4 SCRY_CONCURRENCY_TASKS=16 SCRY_CONCURRENCY_SCENARIO=stream \
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs \
  concurrency-stream-tasks16-limit4 -- node scripts/session-concurrency-bench.mjs
```

前提：依赖与 Electron 原生模块需按现有测试流程准备，源码需已有对应构建。脚本只会拒绝测量过程中 artifact 或 harness 发生变化，不替代构建，也不单凭 hash 证明构建新鲜度。允许的取值只有：

- `SCRY_CONCURRENCY_RUNS`：`4` 或 `16`（active 上限）。
- `SCRY_CONCURRENCY_TASKS`：等于上面的上限，或 `16`；默认等于上限。
- `SCRY_CONCURRENCY_SCENARIO`：`stream`、`quiet`、`big-output`、`history-switch`。

wrapper 在另一 timing run 持锁时以退出码 75 结束（稍后重试，不要并发跑两个计时）。报告 JSON 内含身份（源码/artifact/harness/fixture hash、平台、CPU、Node/Electron/App 版本）、workload（tasks 与 concurrency）、每任务证据与 evaluation checks、CPU/内存/队列/trace health/归档/cleanup lane；**`highLoad` 不在报告 JSON 里**，它来自同一 stdout 最后一行 `SCRY_TIMING_RUN=<json>` footer。高负载下的结果只能当功能证据使用。
