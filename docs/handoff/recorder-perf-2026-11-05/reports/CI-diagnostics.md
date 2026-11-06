# PR #31：性能门禁专项诊断

维护者在原五轮 Sol 复核结束后，明确授权扩大到测量 / runner 诊断与必要修复，最多追加两轮 Sol；不放宽门槛，不循环重跑刷绿，不新增付费或生产操作。

## 已有失败，不撤销

提交 `84a49201` 的 [run 42224305503](https://github.com/bingjiang0611/scry/actions/runs/42224305503)：Check、Remote Check 通过，Performance Check 失败。

| 证据 | 结果 |
|---|---|
| Native 主比较 | 132 行中 8 项回归；同产物对照正向 1 项、反向 15 项回归；三个 wrapper 均 highLoad |
| Node source-control.diff | batch-mean p95 28.830 → 121.687ms，上限 43.245ms；同产物 control 为 30.137ms；三个 wrapper 均非 highLoad |
| Node 最慢批次（两次操作） | 243.374ms；event-loop idle 205.110ms，active 38.278ms，进程 user/system CPU 11.114/17.183ms，重叠 GC 约 1.666ms |
| Native short-heavy 慢窗口 | git_baseline_ready 的 delta 336.7ms；同一资源窗口 main eventLoopMax 297.5ms。没有因此认定两者同因 |

Node 的实际 workspace diff 调用路径没有被本 PR 改动；追加的 raw-numstat parser 不被该 workload 调用。这缩小了定位范围，但不能证明异常的来源。Native 的高负载与同产物波动同样不能排除产品回归。

原始 artifacts：`performance-results` 13505565462、`performance-native-results` 13504329550。下载副本位于 `/tmp/scry-pr31-compare-final/`、`/tmp/scry-pr31-native-final/`。更早的失败继续保留在 [PR-follow-up.md](PR-follow-up.md)。

## 最小区分实验

假设：部分长等待来自进程外调度停顿，而非被测 App 的同步工作。只看 App 自己的 event-loop delay 无法区分；新增安静计时父进程的独立观测，按 UTC 窗口与现有 App trace / Node batch 记录对齐。

- `timing-observation.mjs` 每 250ms 读取 CPU ticks 与 20ms 分辨率的父进程事件循环直方图；保留最多 4096 个窗口，截断显式标注。未知值为 null，不为 0。
- `observerCpuMs` 记录父进程自身 CPU 开销，不含被测子进程；CPU tick 比例不是 VM steal 或调度争用的直接测量。
- Node / native 两侧均冻结同一 wrapper 和依赖。采样不改变 workload、样本数、预算、原始比较、highLoad 规则、子进程退出状态和必需检查。
- 原始失败继续阻止合并。新增的是归因证据，不是性能修复。即使后续绿灯，也不能据此声称历史异常已修复。

## Sol 第 6 / 7 轮

同一原生 reviewer session，`openai-codex/gpt-6.1-sol`；两轮状态均显示 thinking high。

| 轮次 / run | 结论 | 处理 |
|---|---|---|
| 6 / `19b4f1eb-dafc-4dfa-b106-3309b8139303` | CHANGES，S4 should | 大 JSON footer 写到 pipe 后立即 process.exit，可能截断。负对照确实只得到 65,536 字节 |
| 7 / `2699773d-962b-4241-98df-5ccaf17129cd` | APPROVE，S4 resolved | 改为 process.exitCode，让 stdout 自然排空；真实 pipefail + tee 回归检查完整 JSON、4096 样本、文件逐字相等及退出码 7 |

状态回执分别显示约 21k / 6.9k tokens；未提供费用，不估算。没有开放的代码 blocker / should；该批准不等于性能门禁通过。

## 跨运行方向对照

三次 native 失败（42198944979、42224305503、42239197641）中，逐场景中位数差异的**方向在翻转**，并没有稳定的退化信号：

| 场景 / 指标 | 42198944979 基线→候选 | 42224305503 基线→候选 | 42239197641 基线→候选 |
|---|---:|---:|---:|
| short / 打开中位 ms | 92.2 → 104.2 | 73.1 → 37.7 | 38.5 → 69.5 |
| short / complete 发→终态中位 | 184.6 → 138.8 | 153.0 → 66.0 | 57.5 → 87.2 |
| short-heavy / 打开中位 | 276.5 → 376.2 | 220.4 → 123.4 | 138.9 → 134.9 |
| paged / 打开中位 | 121.2 → 138.0 | 71.8 → 78.5 | 62.7 → 42.6 |

同一份 `short` 输出在相邻两次测量里几乎对调（73.1→37.7，然后 38.5→69.5）。最近一次中 `short` 的每个 compose 指标都约为基线的 1.6–1.9 倍，而同产物第三次运行（control，二进制逐文件相同，只有 `main/index.js` 因产品改动不同）又回到基线水平。因此该次差异跟随测量窗口，而不是被比较的代码。

同一次运行的 Node Git 场景已通过（38.103 → 35.491ms），此前的 121.687ms 异常未复现；这与同批次内 205ms 的阻塞等待一致，即宿主机 I/O 停顿，而非被测进程自身计算。

父进程诊断没有在失败窗口记录到与之等量的停顿（native 最大 110–131ms，Node 最大 21–24ms），说明单次运行的偏差不是可观测的整机暂停，而更像持续半个测量窗口的频率/邻居负载差异。**这不能证明代码无回归，也不能把失败改写成通过。**

## 仍阻塞的事实

门禁协议原为“每一侧只测一次，然后比较两侧”。只要某一侧整个测量窗口处于不同机器状态，就会产生假回归；三次成功/失败方向因此不稳定。

## 已批准的协议修正（场景级交替）

维护者在上述证据下明确批准修改测量协议：native 的四个场景改为**每个场景 base / candidate 背靠背各测一次**，随后用 `combine` 合并成两侧完整报告。保持不变的是：门限、指标集合、每场景样本数、固定工作量、warmup、App 启动次数、比较器与必需检查。改变的是测量顺序，使一个持续数十秒的机器状态窗口不能整体落在单侧。

`combine` 同时强化而不是放宽证据：分片的 revision / harness / environment 必须一致，缺场景、重复场景或任一分片含失败 lane 都直接失败；失败时不写半成品报告；合并后的报告仍走原有 `compareNative` 预算与 base-relative 判定。Node job 未改动。

本机真实产物的端到端验证：把上一轮 CI 的 `candidate.json` 按场景拆成 4 个真实分片，用真实 CLI `combine` 重建完整报告（4 场景、0 errors、72 条 counters 观测）；把其中一个分片改到另一 revision 后 CLI 以 `shard revision differs` 失败，且未留下半成品输出。


| 检查 | 结果 / 日志 |
|---|---|
| 定向 tests：timing、Node workflow、native、feedback、PR workflow | 最终 5 文件 / 55 passed；`/tmp/scry-pr31-timing-final-tests.log` |
| 类型检查 | 最终通过；`/tmp/scry-pr31-timing-final-typecheck.log` |
| App build | 通过；`/tmp/scry-pr31-timing-build.log`。之后只改 wrapper / test / 文档，没有 App 输入变化 |
| 真实 wrapper 子进程退出 7 | 仍返回 7；highLoad 判定不变，诊断存在；`/tmp/scry-pr31-timing-exit.log`。该高负载短夹具不是速度结论 |
| 检测器负对照 | 独立进程主动阻塞事件循环 120ms，被检测为至少 100ms；不是等待机器变空闲 |
| 交替测量分片合同 | native 14 tests（含 3 个新用例）、PR workflow 1 用例均通过 |
| 交替测量旧协议负对照 | 把 `performance.yml` 换回旧版本后，新断言失败（`for scenario in …` 缺失） |
| 真实 CLI `combine` 冒烟 | 4 个真实分片→完整报告；跨 revision 分片被拒且无半成品输出 |

自查：未改变事件触发器、token 权限、检查名称、预算、固定工作或比较器；未触碰日常 App / daemon。所有本次完整暂存文件需保持 ≤20,000 bytes。下一步由 Agent 推送该诊断改动，读取新一轮原始产物；尚未验证远端诊断或解决原性能失败。

本地 Electron 为 ABI 146，而仓库 `better-sqlite3` 编译为 Node ABI 137；`electron-builder install-app-deps` 在离线/长时间重建时未能完成，因此本轮没有在本机原生复现采样，未经本地 native 验收。CI 侧两份产物均保留（`~/Library/Caches/scry-pr31-evidence/`）。
