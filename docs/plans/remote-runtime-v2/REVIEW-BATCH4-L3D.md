# Batch 4 核验（B4-L3：M1–M3、S1）

核验对象：`8db2631..685157a`，其中 `756690e`、`058fe35` 已在执行期间预看过。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 `status/b4-l3.md`，以及 `daemon-run-runtime.ts`、`daemon-run-lazy.ts`、`daemon-run-transport.ts`、`daemon-client.ts`、`scripts/daemon-mode-timing.mjs` 的源码。本轮没有在本机重跑测试或真实 App。

## 结论

M1、M2 可以接受。M3 跑通了真实 App，并顺带修掉了十个真实缺陷，这一段的价值很高。

但 **L3 仍不能关闭**，原因有三：

- daemon 模式下“流式输出”这条用户路径，目前的证据互相矛盾；
- 同一个 daemon 会话中，第 30 次 start 稳定失败；
- 录制失败在本机界面上能否显示，仍然没有证据。

首 token 超出预算，这一项需要维护者决定。

## 接受

| 项 | 说明 |
|---|---|
| M1 | lane 层区分“确认没发出”（`notSent`）和“发出后结果未知”。只有前者映射为可重连的 `daemon_not_running`，无法归类的错误一律按“结果未知”（`daemon_outcome_unknown`）处理，不会重放。`start` 的 intentId 在第一次尝试之前就固定，结果未知时用 `intentState` 核对，查不到就报 `daemon_submit_unknown`。`DaemonClientError` 在请求路径上只会在“没有 grant、请求还没发出”时抛出（`daemon-client.ts:172`），所以把它当作可重发是安全的。三条规则各有控制实验 |
| M2 | admission 和 session 这些行改判为“传输与台账”，理由成立：daemon 没有窗口意义上的“当前会话”。原来的保护改由 App 显式发送的会话身份承担，“正在删除”“同一会话已有 run”这两项检查也已经从 daemon 提交路径测过。dock badge、未读状态、`focusedRun` 推送在开关打开时不可用，已如实列出 |
| M3 | `daemon-mode-smoke.mjs` 在独立 userData/HOME 下全部通过 `window.scry` 驱动真实 App：发送、首段文本、结束、两次提问作答、停止后 `cancelled`、SIGKILL daemon 后重拉、新 run 结束，全部通过。期间修复的 10 个缺陷每个都先写了失败测试，包括：bind 标记在不同 run 之间串台、trace 和作答用错 id、提问没有送到 renderer、daemon 退出后窗口卡死 |
| S1 | 测量方法符合已决定的条件：同一构建、同一个 paced fixture、只切换开关、串行加锁、记录负载。结果如实写为未达成，没有挑选有利的样本 |

## L3 必须补

### L1 流式输出：修复说明与实测数据矛盾

`118dbf6` 的说明是：同一 item 的文本增长会按尾部推送 `text_delta`（`daemon-run-runtime.ts:348-351`），已修复“只显示第一块”。可是在它**之后**测量的 S1 显示，daemon 模式下每个样本**只收到 1 个**文本事件，进程内是 20 个，而首 token 出现在 177 ms 左右。这意味着用户看到的是：第一块文字出来后，一直到 run 结束都没有任何更新。也就是说，这个缺陷要么没修好，要么在打包或计时的构建里没有生效。

执行方把这一点归因于“trace delta 契约按消息合并，不在 L3 范围内”。但流式输出是 CLAUDE.md 列出的核心用户路径，而且在 L3 之前的 in-process App 里它是正常工作的。开关打开后不再流式，属于本机缩水，违反了“本机不缩水”的决定。

另外，M3 的 smoke 只检查 `firstText`，所以它证明不了流式输出。

修法：

1. 先查清矛盾：计时用的构建是否包含 `118dbf6`；尾部 `text_delta` 有没有被 renderer 按 id 去重或者丢掉；run 视图在长轮询窗口内是不是要等消息结束才变化。
2. 修复之后，在 M3 的 smoke 里加一条断言：paced fixture 下，renderer 至少收到 N 个递增的文本事件，并且相邻事件的间隔接近 150 ms 的节奏。不能只看第一段。
3. 重新测 S1 中的“逐次更新间隔 P95”，与进程内对比。

如果查明根因确实需要改 trace delta 契约，就停下写进「需要决定」，不能带着“不流式”进入 B4-S。

### L2 同一 daemon 会话里第 30 次 start 稳定失败

S1 记录了：连续第 30 次 `start` 会以 `daemon_run_not_bound` 失败（bind 等待 3 s），四次尝试都复现，重启 App 或重建 daemon 状态目录都不能避免。

每次都精确地停在第 30 次，几乎可以肯定是某个上限或窗口造成的。例如：`liveRuns` / 回执 / bind 标记的扫描范围、run output 或 progress 的分页上限、某个按 run 计数的有界缓存。一个用户在一个会话里跑 30 轮很常见，所以这是功能缺陷，不是“待查”。

修法：先写一条复现测试（同一个 daemon 连续 start 31 次），定位是哪一个上限，再修复并解释原因。修复之后，S1 要补满 30 个样本。

### L3 录制失败在本机界面上可见（M2 预看时已经提出）

`058fe35` 证明了 daemon 侧会产出 `recording: 'failed'` 和 `run.error`。但 App 在开关打开时使用的 run 视图（`daemon-run-runtime.ts`、`daemon-run-transport.ts`）里，**没有任何代码读取 `recording` 字段**。错误文本也许会随 trace 快照到达，但“录制失败”这个状态能否像 in-process App 一样显示出来，仍然没有证据。这关系到证据诚实，属于 CLAUDE.md 第 1 条。

修法：

- 补一条从 daemon 帧到 App 视图的测试；
- 在 M3 的 smoke 里制造一次录制失败（用现有 fixture，或注入失败），断言界面上出现的是与 in-process 相同的录制失败状态，而不只是一段错误文本。

### L4 门禁表过期

`b4-l3.md`「门禁」一节仍是早先的数字（3032 passed），并把 `daemon-trace-latency` 的 3.89 ms 列为通过。需要更新为本轮实际的结果，并把旧的计时改标为“只测泵的单次往返开销，不代表首 token”。

同一文件第 12 行“除重新连接这一条需要先定 UI 归属”已经过期，应删除，因为维护者已经确认。

## 需要维护者决定：首 token 超出预算

实测首 token P95：进程内 140.3 ms，daemon 209.0 ms（另一次采集为 177.1 ms），比预算 +10 ms 多出约 +37～+69 ms。

按 2026-11-07 的决定，超出预算时应单独提出 push 订阅。核验方建议**先查清多出来的时间花在哪里，再决定要不要做 push**。

依据：

- 单次 socket 往返实测只有 3.9 ms；
- 而 `start()` 要等 bind 标记（上限 3 s）之后，泵才开始读；
- 长轮询窗口的唤醒时机也会叠加进来。

所以多出来的 60 ms 左右，大概率出在“提交 → dispatch → bind → 第一次 watch → 第一次 trace 读取”这条链上，不在传输层。push 不一定能解决它。

建议的顺序：

1. 补一份分阶段计时：submit、recorded、dispatched、bound、第一次 watch 返回、第一次 trace 读取、renderer 收到，各段的 P50/P95。
2. 如果主要耗时在 bind 等待或轮询节奏上，就在现有协议内修复（例如 watch 一旦有 progress 就立即返回、bind 和首读合并为一次），然后重测。
3. 修完仍然超出预算，再写 push 订阅的设计提案，交维护者决定。

## 下一步

按 L2、L1、L3、L4 的顺序完成。L2 的 bind 失败可能和 L1 的流式问题有关联，最好一起排查。然后做首 token 的分阶段计时。全部完成后停下等核验。

## 维护者答复（2026-11-08）

首 token 超出预算：按核验方建议，**先做分阶段计时再决定**。拆出 submit → recorded → dispatched → bound → 首次 watch 返回 → 首次 trace 读取 → renderer 收到 各段的 P50/P95，优先在现有协议内修；修完仍超出 +10 ms 预算，再写 push 订阅设计提案交维护者决定。预算本身不放宽。
