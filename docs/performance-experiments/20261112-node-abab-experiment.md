# Node ABAB / 20样本实验（不合入 main）

## 授权与边界

维护者批准独立实验：同一 runner 连续三轮，Node 场景按 ABAB 交替、每侧每场景至少20个样本，并记录批内 Git/文件阶段。先提交结果审阅，不修改正式门限公式，不合入 main，不改 native 测量或产品实现。

本分支暂时用**已注册的** `.github/workflows/performance.yml` 作为只读、手动实验入口；它不是可直接合入的正式 CI 配置。main 上的原工作流不受影响。原有工作流合同测试保持原样，不为实验分支改写断言；本分支不宣称完整正式 CI 通过。

## 测量方法

- 一个 Ubuntu job 内运行三轮；每轮启动新的两侧 worker 与独立临时 fixture。
- 冻结同一套 fixture、场景与诊断代码到两侧；不覆盖 baseline 的产品实现。
- 17个原 Node 场景、原 workload、预热与批内 iterations 保留。每场景严格执行 A1、B1、…、A20、B20，测量批次不并发。
- 保留全部20个原始样本。最近秩 P95取第19个排序值；数值相同仍可能等于最大值。
- `performance-compare.mjs` 的默认15样本入口保持原合同；实验显式传入20样本合同，并仅在内存策略副本中替换 sample count。固定上限、counter ceilings与公式完全不变：`min(policy.p95Ms, baselineP95 + max(10ms, baselineP95 * 0.5))`。不截样本、不伪装采样元数据。
- 批次携带 side/scenario/batchId、起止时间、CPU、事件循环与真实计数。跨批工作计数必须一致。

## 阶段诊断及限制

benchmark-only wrapper调用真实 fs与execFile，保留参数、返回、错误以及promisified execFile的原Promise/child属性。它记录命名同步/异步fs API和真实Git命令区间，不改产品代码。普通Node/shell exec不冒充Git。

每批最多256个详细stage，超过后明确记录droppedStageCount；触发上限后已增加stageTotals，对所有被观测调用按固定的Git/file/process三类保留完整count、非独占totalMs和maxMs，不截断汇总。GC最多512条并记录丢弃数。区间可能并发，不能把duration之和当作独占总耗时。覆盖范围不包括FileHandle方法、native模块与子进程内部syscall，不是完整文件审计。若待分析峰值对应批次有丢弃或残余时间无法归因，应增加按操作聚合或定向FileHandle诊断，再作根因结论；不能用未记录解释为“没有操作”。

## 验证设计

- 编排回归验证20对顺序、样本合同、有限值、socket协议与有界阶段数据。
- 合成分位数fixture明确区分第19样本与第20最大值；真实TraceOutputBridge重复投递使工作量翻倍，比较器必须报回归。
- 本机完整同源码握手最小实验先暴露split export错误并修正；修正后在预热阶段遇到既有resources-shell的1秒子进程预算（SIGKILL/timedOut），没有得到完整本机计时。未增大该预算、重试到绿或把失败当测量成功。
- 三轮原始JSON、worker日志、失败与comparison分别保存。测量失败与真实回归分开标识。实际远端结果、revision及运行链接见下。

## 同一runner连续三轮：实测结果

运行：[43187744081](https://github.com/bingjiang0611/scry/actions/runs/43187744081)；单一Ubuntu job，4 vCPU，AMD EPYC 7763，Node 24.22.2。测量wrapper总墙钟76067ms，load 1.26→1.60，highLoad=false。

A：`5a63338480769aa9cd12abd0254aa17fc31f3a96`；B：`a0672e0f9bf1b3438b761adfc5c0e0ef573a3e5b`（产品代码基于2e10e2f6，只有实验harness改动）。每轮两侧harness hash与environment一致。3轮均完成，每轮17场景×每侧20样本，61项比较均通过；共2040个批次均保留。

### source-control.diff（ms）

| 轮次 | A P95 | B P95 | A最大 | B最大 | 原公式门限 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| 1 | 87.084 | 102.836 | 152.461 | 106.064 | 130.626 | pass |
| 2 | 63.390 | 59.246 | 68.052 | 65.265 | 95.085 | pass |
| 3 | 57.612 | 59.903 | 58.200 | 61.065 | 86.418 | pass |

### 最大批次的阶段证据（ms）

每侧各取自己的最大批次，**不是同一A/B配对**。批次包含2次原迭代，wall列不是batch-mean。Git/文件区间可重叠，不能相加当成独占总耗时。完整120个source-control批次均有Git与文件阶段，均无stage丢弃。

| 轮次 | 侧 / 批次 | 批次wall | Git区间和（非独占） | 文件区间和（非独占） | 丢弃 |
|---|---|---:|---:|---:|---:|---:|
| 1 | A / A17 | 304.922 | 268.023 | 46.954 | 0 |
| 1 | B / B16 | 212.129 | 185.950 | 17.135 | 0 |
| 2 | A / A1 | 136.103 | 147.024 | 4.829 | 0 |
| 2 | B / B1 | 130.530 | 138.511 | 4.833 | 0 |
| 3 | A / A6 | 116.399 | 122.118 | 3.663 | 0 |
| 3 | B / B1 | 122.130 | 130.848 | 4.836 | 0 |

persistence.archive与workspace.files每侧每轮分别丢弃20680、15640条详细stage；这些场景的逐操作区间是partial，不能据此对完整文件阶段作根因结论。三个round的GC丢弃数均0。批次总耗时和20个原样本仍完整。这是a0672e0f初版的限制；后续已增加不截断的阶段汇总，补测结果另列，原三轮不覆盖。

### 全部场景 P95 / 原公式门限（ms）

| 轮次 | 场景 | A P95 | B P95 | 门限 | 结果 |
|---|---|---:|---:|---:|---|
| 1 | startup.recovery | 1.999 | 1.870 | 11.999 | pass |
| 1 | providers.catalog | 0.250 | 0.258 | 10.250 | pass |
| 1 | navigation.catalog | 0.537 | 0.491 | 10.537 | pass |
| 1 | history.page | 0.140 | 0.148 | 10.140 | pass |
| 1 | compose.drafts | 0.879 | 0.775 | 10.879 | pass |
| 1 | persistence.archive | 21.956 | 24.074 | 32.934 | pass |
| 1 | evidence.projection | 0.239 | 0.237 | 10.239 | pass |
| 1 | analytics.stats | 0.820 | 0.821 | 10.820 | pass |
| 1 | workspace.files | 27.792 | 28.117 | 41.689 | pass |
| 1 | source-control.diff | 87.084 | 102.836 | 130.626 | pass |
| 1 | terminal.delivery | 0.462 | 0.480 | 10.462 | pass |
| 1 | send.codex-fixture | 40.503 | 40.727 | 60.755 | pass |
| 1 | controls.stop-lifecycle | 40.596 | 40.460 | 60.894 | pass |
| 1 | remote.loopback | 1.680 | 3.374 | 11.680 | pass |
| 1 | resources-shell.process | 35.281 | 36.988 | 52.921 | pass |
| 1 | trace.delivery | 2.460 | 2.612 | 12.460 | pass |
| 1 | renderer.batch | 0.512 | 0.588 | 10.512 | pass |
| 2 | startup.recovery | 2.414 | 1.975 | 12.414 | pass |
| 2 | providers.catalog | 0.268 | 0.252 | 10.268 | pass |
| 2 | navigation.catalog | 0.515 | 0.621 | 10.515 | pass |
| 2 | history.page | 0.150 | 0.151 | 10.150 | pass |
| 2 | compose.drafts | 0.758 | 0.903 | 10.758 | pass |
| 2 | persistence.archive | 19.048 | 18.606 | 29.048 | pass |
| 2 | evidence.projection | 0.192 | 0.213 | 10.192 | pass |
| 2 | analytics.stats | 0.784 | 0.792 | 10.784 | pass |
| 2 | workspace.files | 26.353 | 26.544 | 39.530 | pass |
| 2 | source-control.diff | 63.390 | 59.246 | 95.085 | pass |
| 2 | terminal.delivery | 0.564 | 0.480 | 10.564 | pass |
| 2 | send.codex-fixture | 40.364 | 40.202 | 60.545 | pass |
| 2 | controls.stop-lifecycle | 41.552 | 40.000 | 62.329 | pass |
| 2 | remote.loopback | 3.239 | 1.554 | 13.239 | pass |
| 2 | resources-shell.process | 36.767 | 35.589 | 55.151 | pass |
| 2 | trace.delivery | 2.398 | 2.302 | 12.398 | pass |
| 2 | renderer.batch | 0.504 | 0.626 | 10.504 | pass |
| 3 | startup.recovery | 1.879 | 1.767 | 11.879 | pass |
| 3 | providers.catalog | 0.301 | 0.263 | 10.301 | pass |
| 3 | navigation.catalog | 0.540 | 0.501 | 10.540 | pass |
| 3 | history.page | 0.159 | 0.124 | 10.159 | pass |
| 3 | compose.drafts | 0.820 | 0.722 | 10.820 | pass |
| 3 | persistence.archive | 18.810 | 18.895 | 28.810 | pass |
| 3 | evidence.projection | 0.255 | 0.186 | 10.255 | pass |
| 3 | analytics.stats | 0.794 | 0.777 | 10.794 | pass |
| 3 | workspace.files | 27.970 | 28.580 | 41.955 | pass |
| 3 | source-control.diff | 57.612 | 59.903 | 86.418 | pass |
| 3 | terminal.delivery | 0.595 | 0.489 | 10.595 | pass |
| 3 | send.codex-fixture | 39.843 | 40.633 | 59.764 | pass |
| 3 | controls.stop-lifecycle | 40.780 | 40.324 | 61.170 | pass |
| 3 | remote.loopback | 1.581 | 1.516 | 11.581 | pass |
| 3 | resources-shell.process | 39.051 | 35.832 | 58.577 | pass |
| 3 | trace.delivery | 2.445 | 2.448 | 12.445 | pass |
| 3 | renderer.batch | 0.525 | 0.523 | 10.525 | pass |

原始样本、每批阶段、worker日志与comparison位于该run的performance-abab-results artifact，本机副本为/tmp/scry-approved-followups/abab-remote/。三轮完成且通过证明本实验可运行，不证明已消除噪声；首轮与后两轮的绝对耗时仍明显不同。新实验的CPU、runtime、采样和诊断方式均不同于原失败，不能跨运行比较绝对耗时，也不能倒推原53.858ms峰值的底层原因。实验未合入main，正式门限、预算文件与native测量未修改。
