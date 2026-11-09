# L3E 首 token 分段复测（daemon vs 进程内）

分支 `claude/remote-runtime-v2`。测量脚本 `scripts/daemon-mode-timing.mjs`，本轮新增分段标记（`src/main/run-stage-timing.ts`）。协议版本未改，预算未放宽。

## 方法

- 每个模式 30 个样本，同一构建、同一夹具 prompt（`performance paced stream`，20 段 150 ms 间隔的 paced 文本）、同一临时 workspace；两个模式只差 `SCRY_HOST_DAEMON`。
- 每 15 个样本重启一次 App（每个实例的第 1 个样本含 App 冷启动，单列，不计入 warm 中位）。
- 串行执行、持宿主机计时锁（`.agents/skills/scry-performance-climb/scripts/timing-run.mjs`），并记录前后 1 分钟 load。
- 时钟：每个进程写 `performance.timeOrigin + performance.now()`，即墙钟绝对毫秒；App 主进程、daemon、渲染进程因此可以直接相减，不需要估算进程间偏移。渲染侧到达时间用 `Date.now()`（毫秒精度，偏差 <1 ms）。
- 打开方式：`SCRY_RUN_TIMING=1`（supervisor 显式转发给 daemon）。关闭时只多一次 `runStageTimingEnabled()` 判断，`trace-output.ts` 与 `trace-runtime.ts` 都在关闭时跳过标记逻辑。

阶段定义：

| 阶段 | 谁写 | 含义 |
|---|---|---|
| `submit` | daemon | 提交请求到达 gateway（在写 ledger 之前） |
| `intentDurable` | daemon | `recordIntent` 同步 append + fsync 返回之后 |
| `dispatch` | daemon | dispatcher 调 executor 之前 |
| `providerStart` | 两个模式 | `runProvider` 真正启动 Provider 之前（同一函数） |
| `firstOutput` | 两个模式 | 第一条 Provider 文本事件进入 `publishTrace` |
| `traceRead` | daemon | daemon 回答一次**含文本**的 trace 读 |
| `watchReply` | daemon | 内容唤醒的长轮询回复发出 |
| `rendererPush` | 两个模式 | 主进程 `TraceOutputBridge` 交给渲染进程之前 |

## 结果（30 样本，同构建）

load：daemon 3.18 → 1.76（8 核）；进程内 2.27 → 3.36。两个模式各有一批慢样本，warm 中位单列。

| 指标 | daemon | 进程内 | 差 |
|---|---|---|---|
| 首 token P50（全部 30） | 211.7 | 131.2 | +80.5 |
| 首 token P95（全部 30） | 269.1 | 264.6 | +4.5（两边各含冷启动样本） |
| 首 token P50（warm，各 28） | 210.5 | 129.6 | +80.9 |
| 首 token P95（warm） | 247.5 | 168.3 | +79.2 |
| 更新间隔 P50 / P95 | 152.2 / 160.4 | 151.4 / 164.4 | 已一致 |
| 文本事件 / 样本 | 20 | 20 | 已一致 |

分段（同一批样本的 P50 / P95，ms；空白＝该模式没有这个阶段）：

| 段 | daemon | 进程内 | 说明 |
|---|---|---|---|
| 提交 → Provider 启动 | 134.8 / 188.4 | 113.8 / 243.0 | 含 App 自身准备（diff baseline 等），两边同名不同内容 |
| ├ `submit → intentDurable` | 4.8 / 9.4 | — | ledger 同步 append + fsync |
| ├ `intentDurable → dispatch` | 4.9 / 11.1 | — | dispatcher 取件 |
| └ `dispatch → providerStart` | 118.2 / 167.8 | — | App 侧准备，进程内模式里同样存在但无 dispatch 标记 |
| `providerStart → firstOutput` | 23.6 / 31.9 | 18.1 / 22.3 | Provider 进程启动 + 首个分片 |
| **`firstOutput → rendererPush`（交付尾段）** | **54.2 / 59.8** | **0.2 / 4.0** | 见下拆分 |
| ├ `firstOutput → traceRead` | 0.6 / 1.7 | — | daemon 回答含文本的读 |
| ├ `traceRead → watchReply` | 14.4 / 20.0 | — | 到内容唤醒回复发出 |
| ├ `watchReply → rendererPush` | 39.0 / 43.6 | — | App 收到唤醒后到交给窗口 |
| └ `rendererPush → 渲染收到` | 0.9 / 2.1 | 0.1 / 2.5 | 最后一跳，两边都小 |

每个样本的首 token（ms，按执行顺序，每 15 个跨一个实例）：

- daemon：269.1 204.2 210.5 204.7 209.6 204.2 204.8 269.7 246.1 238.3 215.6 231.9 201.5 203.7 205.3 | 252.7 193.9 220.8 204.3 211.7 242.9 214.7 241.9 245.8 225.8 192.7 247.5 193.5 209.7 209.2
- 进程内：278.9 253.2 133.9 119.6 117.2 119.6 122.2 123.7 139.6 143.2 131.2 131.6 168.3 161.9 128.7 | 264.6 128.3 114.8 125.1 127.2 117.4 121.4 121.4 132.2 133.6 129.6 136.3 156.5 148.2 123.6

## 结论

1. 差的**大头在 Provider 首个输出之后的交付尾段**：daemon 54.2 ms，进程内 0.2 ms。其中 14.4 ms 是「唤醒 → 读取」这一次额外往返，39.0 ms 在 App 收到唤醒之后、交给窗口之前。
2. `submit` 相关的 daemon 专属成本只有约 10 ms（fsync + dispatch）+ 一次提交往返，明显小于尾段。
3. `providerStart → firstOutput` 两边差 5.5 ms，量级与噪声相当，不作为 daemon 的结构性成本。
4. 39.0 ms 是 App 内部的空档，不是传输：唤醒回复在 14.4 ms 就到了，窗口在 53.4 ms 才拿到文本。所以**只把读取改成推送并不能把首 token 压进 +10 ms**，必须同时查这段 App 侧空档（读取循环、`#step` 串行锁、`TraceOutputBridge` 的 16 ms 合批都在这段里，具体是哪一个尚未定位）。
5. 事件间隔与文本事件数已一致：流式粒度不是本次差异来源。
6. 每次运行的耗时分布在 190–270 ms 之间波动，两个模式都受 load 影响；单次结论不可用，只能用 30 样本中位。
