# Batch 4 核验（F1、E2 应修、F2 复测）

核验对象：`b8e9e2a..1beafc0`，其中 `05deafa` 是我的核验 cherry-pick。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 diff 与 `status/b4-l3e-timing.md`；计时与门禁的结果引用执行方的报告，本轮没有重跑。

## 结论

F1、E2 接受。交付尾段从 54.2 ms 降到 8.2 ms，交付已经不再是首 token 的主要来源。剩余差值 +41～+58 ms 的大头，落在 Provider 启动之前的准备阶段，约 +25～+36 ms。这个结论成立，所以 push 订阅（方案 A）现在没有依据，这一点我同意执行方的判断。

但计时中出现了一个**卡死的 run**，必须先查清楚。

## 接受

| 项 | 说明 |
|---|---|
| F1 | 根因找到了：daemon 模式的 `TraceOutputBridge` 没有传 `flushMs`，用的是默认的 50 ms，而且一个 step 结束时没有触发交付；进程内是 16 ms，并且常被 ACK 提前 flush。修复后两边合批窗口一致（16 ms），每个 step 读完一次就 flush，“一次读取一批”的合批规则仍然保留。测试用捕获的定时器（永远不触发），修复前 2 条失败、修复后通过；去掉 step 末尾的 flush 后又会失败 |
| E2 应修 | `RunOutputFileStore.countSince` 只打开 `.idx`，按定长索引计数，不读 `.jsonl` 正文；worker 新增了对应的 op，测试先失败后通过 |
| F2 | 每种模式跑两轮、每轮 30 个样本，同一构建、串行持锁、记录负载，冷启动样本单独列出。剩余差值逐段归位：daemon 专属的提交、fsync 加 dispatch 共 9.5～10.3 ms；Provider 启动相差 4～5 ms；交付尾段 8.2～8.7 ms；准备阶段 +25～+36 ms，目前还无法归因 |
| 清理 | 打点只保留回答了 F1 问题的那些（`e0eaf80`），遗留的测试 daemon 与临时目录已清理 |

## 必须修

### G1 有一个 run 卡住了：没有启动 Provider，也没有进入终态

第一轮 daemon 的 30 个样本中，有 1 个在 30 s 内没有任何文本，没有 `providerStart`，也没有终态；第二轮没有复现。这说明 run 已经提交（或已经 dispatch），却停在 Provider 启动之前的某处，而且没有超时，也没有进入失败态。

对用户来说，这就是界面上一个永远在转、也停不下来的 run（如果它根本没进入 runs 注册表，停止也不会生效）。这违反了 CLAUDE.md 的“证据不能说谎”：状态既不是 running，也不是 failed。

修法：

1. 先写一个高次数复现，例如在同一个 daemon 中连续 start 200 次，每次设 10 s 的看门狗；看门狗触发时，把 ledger 状态（intent、dispatch、run_failed）、daemon 端的 `runs` 注册表、bind 标记，以及 App 端的 cursor 一起保存下来。
2. 根据现场判断卡在哪一层：dispatcher、准入（provider lease、session 互斥）、bind、还是 App 端的 pump。
3. 修复后，任何一个已提交的 run 都必须在有界时间内进入可观察的状态：要么 Provider 已启动，要么带原因的 `run_failed`，要么 App 端显示“结果未知”。不能无限期地停在中间。

这一项完成之前，L3 不能关闭。

## 应做：准备阶段归因（A/B/C 的前置任务）

在 daemon 中，`dispatch → runProvider` 是 125～151 ms；进程内对应的“提交 → Provider 启动”是 112～126 ms。走的是同一条管线，差值没有办法再拆，因为进程内没有同构的打点。

做法：给两个模式补上**同名**的打点，覆盖 `startAppRun → frontdoor → admission → startup → runProvider` 各段。包括：shell env、MCP 快照与 trust 指纹、diff 基线采集、SQLite 写入、会话目录写入。

建议优先验证两个假设：

- **SQLite 跨进程争用**：在开关打开时，App 进程仍然打开着同一个 SQLite 文件（daemon 独占要到 B4-S 才实现），所以 daemon 写入可能要等 WAL 锁；
- **daemon 侧缓存是冷的**：例如 shell env、Provider 探测、指纹缓存，每个 daemon 进程都要重新建立。

如果原因属于前者，B4-S 的单写者改造会自然消除它，这一点要写进 STATUS。

## 交给维护者：S1 是否继续阻塞 L3

L3 已经来回了四轮，功能部分都已验证。剩下的首 token 差值在准备阶段，与“run 经 daemon 跑”的正确性无关。核验方建议：

- **G1 修复后关闭 L3 的功能部分。** S1 保持“未达成”，预算 +10 ms 不放宽，作为 **B4-S（默认切到 daemon）的前置门禁**：S1 达成，或维护者另行在 A/B 中做出决定之前，不得把开关改成默认打开。
- 准备阶段的归因与优化，和 B4-L4 并行进行。开关默认关闭，用户不受影响。

这不等于方案 C 的“长期不修”：它有明确的门禁和截止点。

## 下一步

先做 G1。然后按维护者对上一节的答复，要么关闭 L3 的功能部分并转入 L4，要么继续在 L3 内做准备阶段归因。
