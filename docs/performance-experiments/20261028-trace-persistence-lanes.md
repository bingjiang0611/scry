# 2026-10-28 Trace 内容持久化有界并行

## 现象与目标

当前 packaged build `c816f72482cd57ceb5b46c8f4c6af3abfb83df4db76f887dc13b0b40b43a318d`
的 2,077 个 `agent.trace_content` 样本：

| 指标 | p50 | p95 |
|---|---:|---:|
| enqueue 到 durable enrichment | 203 ms | 5997 ms |
| `queue_drained` 等待 | 148 ms | 5984 ms |

计时从事件进入单一 Promise 队列开始。一次慢 fsync 会让后续 tool/skill/agent 事件全部排队。
直播正文不等这条队列，但 Provider terminal completion 与 canonical archive 会等证据收敛。

目标：不减少任何 durable authority、不提前提交证据，在保持 enrichment 顺序的前提下消除
事件之间不必要的串行等待。

## 测量先行

- 测量提交：`602d162d`。
- 服务时间分段提交：`69fa9f35`，新增 `content_persisted` checkpoint，使日常记录可分别聚合：
  - `queue_drained`：进入 durable lane 前的等待；
  - `content_persisted`：实际 durable content service time；
  - `durationMs`：enqueue 到按序 enrichment 完成。
- 固定负载：8 个事件同时到达，persist 边界被同一个 gate 阻塞，enrichment 必须按 Provider
  事件顺序发布。
- 串行实现需要 8 个 persistence rounds，五次均为 `8`。

## 改动

`LiveTraceIngestion` 使用 8 条有界 durable lane：

1. 每条 lane 内仍然 FIFO。
2. 最多 8 个 `persist(raw)` 同时执行。
3. 独立 commit chain 等待各事件结果，并严格按原 Provider 顺序调用 `onPersisted`、发布
   content-ref enrichment 和错误。
4. `idle()` 仍等待所有 durable write 与按序 enrichment；recorder/archive 的证据收敛边界不变。
5. 失败事件仍保留 raw evidence；后续事件可以完成，但不会越过失败事件乱序发布。

内容编码、SHA-256、已有 blob 完整性比较、双 authority 写入、目录 fsync 和 `EEXIST` 竞争校验
均未删除。

## L1 结果

| 指标 | 基线 | 候选 | 变化 |
|---|---:|---:|---:|
| `persistence.rounds`，8 事件 burst | 8 | 1 | -87.5% |

五次候选采集均为 `1`。`performance:measure --compare 602d162d` 通过，无同场景 worse。
减少的工作没有消失：8 次 durable persistence 仍全部执行；减少的是它们之间的串行等待，
同一批工作在有界 lane 内重叠。

## L2 尝试

临时真实存储负载：16 个唯一事件、每个 256 KiB、单 authority，baseline/candidate 交替 5 轮，
全部经 `timing-run.mjs`：

| 实现 | burst 中位数 |
|---|---:|
| 串行 baseline | 1233 ms |
| 8 lane candidate | 430 ms |

方向上缩短约 65%。但 `SCRY_TIMING_RUN` 的 load 33–37，`highLoad=true`，所以该毫秒结果不构成
可信 L2。较早的 4 lane 尝试在另一组高负载样本中为 1256 → 485 ms；8 lane 略好，故采用 8。

## 限制

- 当前受控 burst 总完成仍高于 100 ms；机器高负载下不能证明新的日常 p95 已低于 100 ms。
- 单 authority 的既有低负载单事件服务时间约 38–46 ms，说明服务时间目标可能成立；双 authority
  和异常 fsync 仍需按新的 `content_persisted` checkpoint 分层观察。
- 本实验不把 terminal completion 提前到证据 durable 之前。若新 build 的 queue p95 仍高于
  100 ms，下一步应分析 authority 数、payload bytes 和 lane contention，而不是继续无界加并发。

## 交付状态

- 优化源码：`4ed7bf7c`。
- 合入：未合入。
- 构建：未构建。
- 安装/生效：未安装。
- L3：待新 build 同场景至少 30 样本、2 个会话。
