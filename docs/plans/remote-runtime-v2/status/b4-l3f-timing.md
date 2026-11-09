# L3F 首 token 复测：App 侧持有已读文本（F1）与复测（F2）

分支 `claude/remote-runtime-v2`。核验：`REVIEW-BATCH4-L3F.md`。协议版本未改，预算未放宽，A/B/C 未选。

## F1：那 54 ms 落在哪一段

在 `#apply` 入口、bridge 入队（`push`）、bridge flush（`sendBatch`）补了同一把墙钟的标记，用同一脚本 3 样本定位：

| 段（P50，daemon，修复前） | 值 |
|---|---|
| `firstOutput → traceRead`（daemon 答出含文本的读） | 0.6 ms |
| `traceRead → bridgeQueue`（App 把文本交给 bridge） | 0.9 ms |
| **`bridgeQueue → bridgeFlush`（停在 bridge 里）** | **45–50 ms** |
| `bridgeFlush → rendererPush` | 0.1 ms |

结论：不是首次 snapshot 没 push（文本 1 ms 内就进了 bridge），也不是 step 串行锁把结果推到下一步，而是 **bridge 的合批窗口**。daemon 模式的 bridge 没有传 `flushMs`，用了默认 50 ms；进程内 pipeline 传的是 16 ms，而且它的 bridge 常被 ACK 提前 flush，所以进程内几乎不等。daemon 的 bridge 没有任何「一步读完」的 flush 触发点，于是每次读都要等满一个定时器。

### 修复

1. daemon 模式的 bridge 与进程内用同一个合批窗口（`flushMs: 16`）。
2. step 结束时 flush：一个 step 就是「App 已经拿到一次完整读」的时刻，这一批在这里交给窗口。合批仍然成立（一个 step 的事件是一批），背压规则不变（`flush()` 仍受同一 high water 与 `canSend` 约束）。

### 证据

| 检查 | 结果 |
|---|---|
| 新测试 `src/main/daemon-run-first-text.test.ts`（捕获定时器、永不执行） | 修复前 2 个全失败（一次都没发出）；修复后 2 个通过，并单独断言「一个 step 一批」 |
| 控制实验 | 临时去掉 step 末 flush 后，同一测试再次失败（2 failed），恢复后通过 |
| 复测（3 样本） | `bridgeQueue → bridgeFlush` 从 45–50 ms 降到 3.7 ms；`firstOutput → rendererPush` 从 54.2 ms 降到 7.6 ms |

## E2 应修：唤醒不再读正文

`RunOutputFileStore.countSince` 直接用定长索引（`INDEX_ENTRY_BYTES`）算数量，不打开 `.jsonl`、不读也不解析正文；worker 转发该 op（`countSince`），App 侧的 `RunOutputLog.countSince` 优先用它。内存存储与不支持该 op 的 store 仍走原有路径。测试：`src/main/remote/run-output-wake.test.ts`（store 双记录调用、文件存储按索引计数、worker 转发）与 `run-output-worker.test.ts` 新增的 op 断言；修复前 3 个失败。

## F2：复测（每模式 2 轮 × 30 样本，同构建）

条件与上次一致：同一脚本、同一 paced 夹具 prompt、每 15 样本重启 App、串行持宿主机计时锁、记录负载、冷启动样本单列。

| 轮次 | daemon 首 token P50 / P95（warm） | 进程内 P50 / P95（warm） | 差（P50 / P95） | 负载 1 min / 8 核 |
|---|---|---|---|---|
| A | 190.5 / 219.7 | 132.6 / 186.6 | +57.9 / +33.1 | daemon 2.27→2.17；进程内 4.04→2.38 |
| B | 167.8 / 205.1 | 126.8 / 165.8 | +41.0 / +39.3 | daemon 2.34→2.60；进程内 1.71→2.52 |

全部样本（含冷启动）：daemon A 191.5 / 230.1、B 168.2 / 207.3；进程内 A 148.0 / 255.8、B 129.6 / 257.1。更新间隔 P50 / P95：daemon 152.1 / 157.9，进程内 151.5 / 164.1（已一致）。

与 L3E 相比：首 token P50 差值从 +80.9 ms 降到 **+41…+58 ms**（两轮），交付尾段 `firstOutput → 渲染收到` 从 54.2 ms 降到 8.2 / 8.7 ms。

### 剩余差值在哪（P50，两轮并列）

| 段 | daemon | 进程内 | 差 |
|---|---|---|---|
| 提交 → Provider 启动 | 161.6 / 137.9 | 125.8 / 112.4 | **+35.8 / +25.5** |
| ├ `submit → intentDurable`（fsync） | 5.3 / 4.7 | — | daemon 专属 |
| ├ `intentDurable → dispatch` | 5.0 / 4.8 | — | daemon 专属 |
| └ `dispatch → providerStart`（准备阶段） | 150.6 / 125.3 | — | 进程内无同构拆分 |
| `providerStart → firstOutput` | 22.7 / 22.8 | 17.6 / 18.7 | +5.1 / +4.1 |
| `firstOutput → 渲染收到` | 8.2 / 8.7 | 0.3 / 0.3 | +7.9 / +8.4 |
| ├ `firstOutput → traceRead` | 0.6 / 0.7 | — | — |
| ├ `traceRead → bridgeQueue` | 0.5 / 0.7 | — | — |
| ├ `bridgeQueue → bridgeFlush` | 3.7 / 3.7 | 0.1 / 0.1 | 一次 step 的合批窗口 |
| └ `bridgeFlush → 渲染收到` | 0.1 / −0.3 | 0.2 / −0.1 | 同一毫秒内 |

先把能确定的写清：

- daemon 专属的提交 + fsync + dispatch 合计 **9.5–10.3 ms**。
- 交付尾段只剩 **8.2–8.7 ms**，其中 3.7 ms 是一次 step 的合批窗口（进程内 0.1 ms，因为它的 bridge 常被 ACK 提前 flush）。
- Provider 启动差 **4–5 ms**。
- 剩下的 **+25…+36 ms 在 Provider 启动前的准备阶段**：daemon 从 dispatch 到 `runProvider` 用了 125–151 ms，进程内从提交到 Provider 启动只有 112–126 ms，两者跑的是同一段 pipeline。这一段目前**无法进一步归因**：进程内的标记没有同样的拆分（baseline 就绪、workspace 准备、git 基线），比较只能停在整段。要继续拆，需要先给进程内补同名标记。这是估计，不是测量。
- 两次 daemon 采集中，准备阶段的差距本身就有 25 ms 的波动（150.6 与 125.3），所以「+41 还是 +58」主要由准备阶段决定，而不是交付段。

### 异常样本（如实记录）

第一轮 30 个 daemon 样本里有 1 个（第 2 实例第 4 个）在 30 s 上限内**没有产生任何文本**：ledger 有 submit/dispatch，App 有一次 trace 读，daemon 侧没有 `providerStart`、没有终态，窗口等到超时才继续。该样本不计入 warm 中位（它是「未测到」，不是「更快」）。第二轮 30/30 全部产出文本，未复现。appLog 尾巴里没有该 run 的记录，原因未定位，需要单独复现。

## 结论

1. F1 的定位成立：那 54 ms 全在 App 侧 bridge 的合批窗口，文本 1 ms 内就到了 App 手里。修复后尾段 8.2–8.7 ms。
2. 首 token 仍超预算：+41…+58 ms P50（P95 +33…+39）。**不在 A/B/C 中选择，不关闭 S1，不改协议版本**，交维护者决定。
3. 若选 A（推送 + 首字即发布）：它最多再省掉交付段里 `traceRead → bridgeQueue → bridgeFlush` 的约 4.9 ms 和一次唤醒往返，**不会解决 +25…+36 ms 的准备阶段差值**。要进 +10 ms，还需要先把准备阶段拆开并优化；推送本身不足以达标。
