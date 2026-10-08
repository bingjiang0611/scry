# Chat clock refresh isolation

日期：2026-10-08；桌面源码基线 `ba7fc3f`（0.2.152），未升版本、未安装。

## 实施范围

`src/renderer/components/ChatView.tsx` 将每秒 wall-clock state 移入本文件的 `RunElapsed` 子组件。原先每个 tick 都重新执行 `ChatView` 的输入历史整理、模型选项构建与轮次遍历；现在 tick 只更新耗时显示。无样式、Provider、IPC、审批或证据持久化合同变化。

仍按当前 run 首个 `TraceEvent.ts` 计算时长；无有效时间戳不显示时长。隐藏文档停 timer，恢复可见时按 wall time 补齐，不按 tick 数累加；换轮次重新绑定时间戳，结束后移除 timer 和 visibility listener。

## 回归证据

复用 `scripts/background-work-ui-smoke.mjs` 的隔离、sandboxed Electron fixture，新增 `mode=clock`。仅这个测试页面替换 wall clock、interval 和文档可见性；浏览器帧调度与生产 React 组件真实执行。

- **先红后绿**：旧代码触发 `Chat clock: timer re-read transcript: 4 -> 6`；新代码一次 tick 的 transcript `userText` getter 额外读取为 **0**，显示从 `00:00` 更新为 `00:01`。
- 同时验证输入框焦点/选区不变、隐藏无 timer、恢复时显示 `01:01`、换轮次重置时长、未知时间戳不冒充零、终态清理 timer/listener。
- 这是组件更新范围的回归证明，不是整机 CPU 降幅、坐标交互或真实三会话吞吐量证明。

## 不调整 trace flushMs 的依据

对当前 `TraceOutputBridge` 运行一次确定性调度探针：5 秒虚拟流，事件间隔分别为 5/50 ms，每条事件包含相同短文本，首次事件在 0 ms；每次发送后固定 16 ms 模拟 renderer commit/ACK，5 秒时 `flushAll()`，5.1 秒检查排空。真实生产 bridge 执行，调度时间为模拟值，不是 CPU/帧率实测。

| 事件/秒 | flushMs | 事件数 | 批次数 | 发送等待 p95 / max（ms） |
| --- | --- | --- | --- | --- |
| 200 | 16 | 1000 | 313 | 16 / 16 |
| 200 | 33 | 1000 | 312 | 16 / 33 |
| 200 | 50 | 1000 | 311 | 16 / 50 |
| 20 | 16 | 100 | 100 | 16 / 16 |
| 20 | 33 | 100 | 100 | 33 / 33 |
| 20 | 50 | 100 | 100 | 50 / 50 |

六种组合均检查 FIFO、无降级、buffer/in-flight 归零。`ack()` 会主动 `flush()`，因此 flushMs 不是持续流的帧率上限。仅调大参数不能证明减少实际 UI 工作，稀疏流反而增加等待，本次保持 16 ms。后续只有真实 renderer profiling 显示流式 commit 为热点时，才评估文本提交节奏；不能降低审批/终态响应或绕过 ACK/证据合同。

隐藏 Shell 标签继续解析输出是另一个候选点，但当前没有该场景的热点证据，不改 detach/replay/ACK 生命周期。触发条件是隐藏 Shell 输出压力下确认 ANSI 解析占主导，再测完整录制与重放成本。

## 实际验证与限制

- `npm run test:unit -- src/renderer/components/render.test.tsx src/renderer/components/background-work.test.tsx src/renderer/performance-style.test.ts src/main/trace-output.test.ts`：4 文件、261 测试通过；SSR 有既有 `useLayoutEffect` 警告。
- `npm run typecheck`、`npm run build`：通过。
- `npm run test:background-ui`：旧代码预期失败，修改后通过，最后定向复验通过。
- `npm run test:renderer:ui`：前三组（session capability、Analytics Credits、chat preview）完成并报告通过；全链路达到执行器 180 秒上限，在最后 background 命令处被中断，**不记为全链路通过**。确认没有残留 background fixture 进程后，仅补跑最后一组并通过；没有增加测试内部超时。同期整机 CPU 空闲为 0%，1 分钟负载约 285。
- 验证期间有并行 iOS 与其他桌面 WIP；不纳入本次提交，上述结果不为它们背书。
- 没有重启正在运行的 Scry，也未重放用户三个真实 Provider 会话。当前构建的完整 App 真实交互、实际 CPU/GPU 降幅及长期内存表现未验证；不将隔离组件 fixture 通过写成完整 App 验收。
