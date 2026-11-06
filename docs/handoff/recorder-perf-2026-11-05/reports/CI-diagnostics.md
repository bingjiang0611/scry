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

## 本地证据

| 检查 | 结果 / 日志 |
|---|---|
| 定向 tests：timing、Node workflow、native、feedback、PR workflow | 最终 5 文件 / 55 passed；`/tmp/scry-pr31-timing-final-tests.log` |
| S4 旧代码负对照 | 1 failed / 4 passed，输出截断为 65,536 字节；`/tmp/scry-pr31-timing-pipe-negative.log` |
| 类型检查 | 最终通过；`/tmp/scry-pr31-timing-final-typecheck.log` |
| App build | 通过；`/tmp/scry-pr31-timing-build.log`。之后只改 wrapper / test / 文档，没有 App 输入变化 |
| 真实 wrapper 子进程退出 7 | 仍返回 7；highLoad 判定不变，诊断存在；`/tmp/scry-pr31-timing-exit.log`。该高负载短夹具不是速度结论 |
| 检测器负对照 | 独立进程主动阻塞事件循环 120ms，被检测为至少 100ms；不是等待机器变空闲 |

自查：未改变事件触发器、token 权限、检查名称、预算、固定工作或比较器；未触碰日常 App / daemon。所有本次完整暂存文件需保持 ≤20,000 bytes。下一步由 Agent 推送该诊断改动，读取新一轮原始产物；尚未验证远端诊断或解决原性能失败。
