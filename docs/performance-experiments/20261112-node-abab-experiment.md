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

## 初版 a0672e0f：同一runner三轮（原记录保留）

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

## 最新 b7ce1aa7：完整阶段汇总后的连续三轮

运行：[43197574995](https://github.com/bingjiang0611/scry/actions/runs/43197574995)。一个job、同一4 vCPU Linux runner，INTEL XEON PLATINUM 8573C，Node 24.22.2。wrapper总墙钟68902ms，load 1.41→2.01，highLoad=false。

A仍为5a63338480769aa9cd12abd0254aa17fc31f3a96，B为b7ce1aa7c7ee683b6ccbcaf1b9bccbe3eab60c8a。17场景、每侧每场景20样本、三轮，每轮61项比较全部通过。此版本只补齐诊断汇总，不改workload、正式预算、门限公式或native测量。以上初版结果保留，不跨两台runner比较绝对耗时。

| 轮次 | A P95 | B P95 | A最大 | B最大 | 原公式门限 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| 1 | 37.758 | 36.663 | 44.661 | 36.725 | 56.637 | pass |
| 2 | 199.853 | 269.040 | 237.860 | 503.115 | 299.780 | pass |
| 3 | 37.664 | 45.950 | 41.309 | 59.268 | 56.497 | pass |

### 阶段记录完整性

独立读取全部2040批次验证：每批汇总count等于详细stage数+droppedStageCount，totalMs/maxMs均有限且非负，汇总时长不小于保留明细时长。覆盖301200个已观测API调用；83280条详细区间保留、217920条被上限截断，但**阶段汇总不截断**。240个批次触发详细上限。校验器对缺少stageTotals的初版artifact确定失败，当前版本全部通过。

汇总只覆盖列出的benchmark-worker API；不冒充全部文件syscall、FileHandle方法或Git内部I/O。Git/file/process各类的区间可能重叠，不是独占总耗时。原始JSON保留每批总时长、完整阶段汇总和最多256条明细。

### source-control各侧最大批次（ms）

这些是各侧自己的最大批次，不是同一A/B配对。每批2次原迭代；CPU为worker自身、不是Git子进程CPU。

| 轮次 | 侧/批次 | 批次wall | Git区间和（非独占） | 文件区间和（非独占） | worker CPU | GC重叠数 |
|---|---|---:|---:|---:|---:|---:|
| 1 | A/A1 | 89.321 | 86.790 | 9.531 | 93.171 | 2 |
| 1 | B/B15 | 73.449 | 74.466 | 3.396 | 39.515 | 0 |
| 2 | A/A2 | 475.720 | 408.089 | 12.563 | 52.079 | 0 |
| 2 | B/B2 | 1006.230 | 573.908 | 325.859 | 48.836 | 0 |
| 3 | A/A1 | 82.619 | 81.961 | 4.983 | 88.241 | 2 |
| 3 | B/B5 | 118.535 | 119.594 | 3.443 | 41.515 | 0 |

第2轮两侧都明显变慢。候选B2的writeFileSync区间173.460ms，整个批次wall1006.230ms，worker CPU48.836ms，GC重叠0。阶段证据已把等待落到真实API区间，但不能区分文件系统I/O、线程停调度或虚拟化暂停；也不能据此倒推原运行53.858ms峰值的原因。三次通过不代表环境噪声已消失。

### 最新三轮全部场景P95（ms）

| 轮次 | 场景 | A P95 | B P95 | 门限 | 结果 |
|---|---|---:|---:|---:|---|
| 1 | startup.recovery | 1.555 | 1.531 | 11.555 | pass |
| 1 | providers.catalog | 0.178 | 0.202 | 10.178 | pass |
| 1 | navigation.catalog | 0.412 | 0.419 | 10.412 | pass |
| 1 | history.page | 0.117 | 0.111 | 10.117 | pass |
| 1 | compose.drafts | 0.745 | 0.753 | 10.745 | pass |
| 1 | persistence.archive | 18.067 | 15.824 | 28.067 | pass |
| 1 | evidence.projection | 0.193 | 0.223 | 10.193 | pass |
| 1 | analytics.stats | 0.713 | 0.735 | 10.713 | pass |
| 1 | workspace.files | 35.949 | 52.064 | 53.924 | pass |
| 1 | source-control.diff | 37.758 | 36.663 | 56.637 | pass |
| 1 | terminal.delivery | 0.391 | 0.407 | 10.391 | pass |
| 1 | send.codex-fixture | 36.284 | 35.774 | 54.426 | pass |
| 1 | controls.stop-lifecycle | 38.269 | 38.562 | 57.404 | pass |
| 1 | remote.loopback | 1.457 | 1.335 | 11.457 | pass |
| 1 | resources-shell.process | 32.842 | 32.277 | 49.263 | pass |
| 1 | trace.delivery | 2.073 | 1.982 | 12.073 | pass |
| 1 | renderer.batch | 0.573 | 0.430 | 10.573 | pass |
| 2 | startup.recovery | 1.664 | 1.572 | 11.664 | pass |
| 2 | providers.catalog | 0.150 | 0.186 | 10.150 | pass |
| 2 | navigation.catalog | 0.426 | 0.419 | 10.426 | pass |
| 2 | history.page | 0.100 | 0.100 | 10.100 | pass |
| 2 | compose.drafts | 0.709 | 0.700 | 10.709 | pass |
| 2 | persistence.archive | 15.519 | 15.420 | 25.519 | pass |
| 2 | evidence.projection | 0.224 | 0.218 | 10.224 | pass |
| 2 | analytics.stats | 0.690 | 0.693 | 10.690 | pass |
| 2 | workspace.files | 45.747 | 49.574 | 68.621 | pass |
| 2 | source-control.diff | 199.853 | 269.040 | 299.780 | pass |
| 2 | terminal.delivery | 0.468 | 0.399 | 10.468 | pass |
| 2 | send.codex-fixture | 37.007 | 35.457 | 55.511 | pass |
| 2 | controls.stop-lifecycle | 38.135 | 35.776 | 57.203 | pass |
| 2 | remote.loopback | 1.412 | 2.858 | 11.412 | pass |
| 2 | resources-shell.process | 32.149 | 33.592 | 48.223 | pass |
| 2 | trace.delivery | 2.054 | 2.023 | 12.054 | pass |
| 2 | renderer.batch | 0.719 | 0.623 | 10.719 | pass |
| 3 | startup.recovery | 1.488 | 1.477 | 11.488 | pass |
| 3 | providers.catalog | 0.147 | 0.191 | 10.147 | pass |
| 3 | navigation.catalog | 0.412 | 0.422 | 10.412 | pass |
| 3 | history.page | 0.121 | 0.126 | 10.121 | pass |
| 3 | compose.drafts | 0.844 | 0.874 | 10.844 | pass |
| 3 | persistence.archive | 14.795 | 14.871 | 24.795 | pass |
| 3 | evidence.projection | 0.199 | 0.349 | 10.199 | pass |
| 3 | analytics.stats | 0.720 | 0.723 | 10.720 | pass |
| 3 | workspace.files | 28.381 | 26.463 | 42.571 | pass |
| 3 | source-control.diff | 37.664 | 45.950 | 56.497 | pass |
| 3 | terminal.delivery | 0.392 | 0.443 | 10.392 | pass |
| 3 | send.codex-fixture | 43.169 | 36.940 | 64.754 | pass |
| 3 | controls.stop-lifecycle | 37.986 | 38.575 | 56.979 | pass |
| 3 | remote.loopback | 1.351 | 1.442 | 11.351 | pass |
| 3 | resources-shell.process | 33.726 | 33.956 | 50.590 | pass |
| 3 | trace.delivery | 1.960 | 2.044 | 11.960 | pass |
| 3 | renderer.batch | 0.581 | 0.630 | 10.581 | pass |

新artifact仍为performance-abab-results，本机副本/tmp/scry-approved-followups/abab-aggregated-remote/。独立校验脚本/tmp/scry-approved-followups/verify-stage-totals.py及结果abab-stage-totals-verification.json保留。复跑数据没有替代初版，也未合入main。
