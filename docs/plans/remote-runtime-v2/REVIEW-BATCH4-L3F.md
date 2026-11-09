# Batch 4 核验（E1、E2、首 token 双侧分段）

核验对象：`d1acf80..b8e9e2a`，其中两条是我的核验 cherry-pick。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：

- 读 `status/b4-l3e-timing.md`、新版 P3e 提案；
- 对照 `daemon-run-runtime.ts#stepOnce`、`run-output-log.ts`、submit 回执的源码；
- 我没有重跑测试或计时；`performance:measure` 用的是执行方报告的结果。

## 结论

E1 接受；E2 的协议面接受，daemon 内部还有一处小的浪费。

分段打点这次做得很到位，结论也和我预期的不同：**差值的大头既不在 daemon 内部，也不在传输上，而在 App 自己手里压着已经读到的文本。** 所以 A（push）、B（重定预算）、C（带着未达成关闭）三个选项现在都不该选。应当先在现有协议内修 App 侧的这段空档，再复测。

## 接受

| 项 | 说明 |
|---|---|
| E1 | 新 run 的 watch 从自己 intent 的全局序号 `receipt.seq - 1` 开始；旧 daemon 不返回 `seq` 时，退回本连接见过的最大 cursor `#seen`。在 12000 条历史事件下，所需的 watch 次数从 48 次降到 1–2 次 |
| E2（协议面） | `output: 'wake'` 只回 `{count, cursor}`，正文不再经 socket 传给 App；有测试断言 App 侧的文本读取函数一次都没被调用 |
| 打点 | 两个进程都用 `performance.timeOrigin + performance.now()`，可以直接相减；由 `SCRY_RUN_TIMING=1` 开启，关闭时 fail-open，热路径只多一次分支判断；`performance:measure` 的 Ratchet 通过 |
| 计时纪律 | 每种模式 30 个样本，串行执行并持锁，记录负载；冷启动样本单独列出；`b8e9e2a` 不在本次计时构建中，这一点已如实说明 |

## 数据说明了什么

daemon 模式下，首个输出之后的交付尾段 P50 是 54.2 ms，进程内是 0.2 ms；首 token 总差值约 +81 ms。拆开来看：

| 段（P50） | 值 |
|---|---|
| `firstOutput → traceRead`（daemon 回答一次**已含文本**的 trace 读） | **0.6 ms** |
| `traceRead → watchReply`（内容唤醒的回复发出） | 14.4 ms |
| `watchReply → rendererPush`（App 交给窗口） | 39.0 ms |

`traceRead` 的定义是“daemon 回答一次**含文本**的 trace 读”。也就是说，首个输出后不到 1 ms，App 就已经收到了文本，但窗口要到约 53 ms 后才拿到。

对照 `#stepOnce` 的顺序（watch → trace 读 → `#apply` → 发布提问）：这次读到的文本**没有在这一步交给窗口**，而是等到下一轮内容唤醒（+14.4 ms）之后又过了 39 ms 才推送。可能的原因有以下几种，需要定位：

1. 首次读到的是 `snapshot`。`cursor.latest === undefined` 时，`#apply` 对 snapshot 的处理可能只更新了内部状态，或者走了 resync，并没有 push；
2. `TraceOutputBridge` 的 16 ms 合批，或者背压在等 renderer 回 ACK；
3. step 的串行锁让读取结果等到下一个 step 才被交付。

不管是哪一种，push 都解决不了它：文本已经到了 App 手里。即使做了 push，这 39–53 ms 仍然存在。反过来，修掉这段持有之后，再加上 E2 后唤醒本身就不再必要，按分段估算，尾段可以降到 1–2 ms。剩下的差值主要是 fsync 加 dispatch（约 10 ms），再加一次提交往返。这是估计，修完要复测。

另外，`dispatch → providerStart` 在 daemon 侧是 118 ms，进程内对应的“提交 → Provider 启动”是 114 ms，量级相当，不构成 daemon 的结构性成本。这与提案的判断一致。

## 必须做（在现有协议内）

### F1 定位并消除 App 侧对已读文本的持有

- 在 `#apply` 入口、bridge 入队、bridge flush 处补打点，用现有的 `run-stage-timing` 即可，确认这 53 ms 落在哪一段。
- 修复目标：**读到的文本在同一个 step 内交给窗口**。首次 snapshot 中已有的文本项，应按“首次交付”推送，不能等下一轮。合批与背压的规则保持不变（16 ms 合批是 App 现有的设计，进程内路径同样受它约束，所以不能拿它当理由，也不能为了数字把它删掉）。
- 测试：daemon 帧层面驱动“首次读取即含文本”，断言同一个 step 内 bridge 收到该文本；用控制实验证明，恢复原逻辑后测试会失败。

### F2 复测

用同一个脚本、同样的条件（每种模式 30 样本、串行持锁、记录负载、冷启动样本单列）复测首 token，并更新分段表与 P3e 提案。

- 复测后仍超过 +10 ms，再把剩余差值所在的段交给维护者，在 A/B/C 中选择；
- 达成预算，就关闭 S1，把 P3e 标为“不需要”。

## 应修

**E2 的 daemon 内部开销。** `countSince` 在文件存储下调用 `store.since(runId, start, DEFAULT_PAGE)`（`run-output-log.ts`），会经 worker 从磁盘读出一整页 chunk 正文、跨线程复制，最后只用来计数。正文虽然不再经 socket 传给 App，但 daemon 内部每次唤醒都要读一页。

`run-output-file` 已经有定长索引（`INDEX_ENTRY_BYTES`），应该直接用索引计数，不读正文。这一项也可能是 `traceRead → watchReply` 那 14.4 ms 的一部分，F1 定位时可以一并看。

## 下一步

先做 F1，再做 F2，E2 的应修项可以同批完成。

在 F2 的结果出来之前，不在 A/B/C 中选择，不改协议版本，预算不放宽。完成后停下等核验。
