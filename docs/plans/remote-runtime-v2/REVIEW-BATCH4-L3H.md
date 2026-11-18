# Batch 4 核验（G1：有界等待）

核验对象：`1beafc0..1232cbf`。其中 `3246992` 是修复，`1232cbf` 是文档，另外两条是我的核验 cherry-pick。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 `context-admission.ts`、`run-admission.ts` 的 diff，并检查 `ContextAdmission` 的全部实例与调用方。本轮没有重跑测试。

## 结论

卡死现场没能复现，执行方改为逐点审计 Provider 启动前所有可能无限等待的位置，这个思路是对的，审计结果和“未证实根因”的说明也都诚实。

但修复的**作用范围超出了审计对象**：20 s 上限被设成了 `ContextAdmission` 的**默认值**，于是所有实例都受影响，包括会话账本的 `ownership` 队列。必须改为只在 run 准入那一处显式启用。

## 接受

| 项 | 说明 |
|---|---|
| 审计方法 | 同一个 daemon 连续 start 300 次，看门狗一次都没触发。改为逐点审计 Provider 启动前的等待点：provider lease 本来就是不阻塞直接拒绝；`SHELL_ENV_TIMEOUT_MS` 与启动恢复都有上限。找出了两处无上限的等待 |
| 超时只发生在“尚未开始”时 | 超时时 action 从未运行过，只释放自己占的位，后续请求不会排在一个空占位后面；`Infinity` 仍表示不设上限 |
| 测试与控制实验 | 修复前两条测试按 4000 ms 超时失败；只把 `withinDeadline` 还原为无条件 await，这两条又会失败 |
| 复现工具 | `scripts/daemon-stuck-run.mjs` 留下了，看门狗触发时会保存现场 |

## 必须修

### H1 20 s 上限对所有 `ContextAdmission` 实例生效，包括会话账本

`ContextAdmission` 的构造默认值改成了 `ADMISSION_DEADLINE_MS = 20_000`（`context-admission.ts`），而这个类有两个实例：

- `session-state.ts:38`：run 准入与会话删除使用，这正是审计的对象；
- **`conversation-store.ts:81` 的 `readonly admission = new ContextAdmission()`**：`conversation-turns.ts:86,192` 和 `conversation-lifecycle.ts` 中 8 处 `ledger.admission.run('ownership', …)` 都排在这一个全局键上。

后果：

- 会话账本的 turn 写入、结算和生命周期变更，只要前面有一个慢操作（例如一次大会话的删除准备），排在后面的写入超过 20 s 就会被直接拒绝。这些写入里包括 turn 的证据落盘，失败就意味着证据丢失或状态不一致，违反 CLAUDE.md 第 1 条。原来的行为是排队等待。
- 报错文案是“等待同会话上一轮收尾超过…，**本轮尚未启动**”，对这些操作并不成立。
- `session-state` 实例上的会话删除（`conversation.ts:136,144`）也会随之在 20 s 后失败。status 文档把这一点记为“行为变化”，但这个变化未经授权，也不在 G1 的范围内。

修法：

1. `ContextAdmission` 的默认值恢复为 `Infinity`，也就是原来的行为。
2. 只在 run 准入处（`run-execution.ts:115` 的 `runMany`）显式传入 `admitDeadlineMs: ADMISSION_DEADLINE_MS`。`waitForCompletedRuns` 已经是在调用处显式传值的，保持不变。这与代码注释里“只有这一处需要上限”的意图一致。
3. 测试：
   - `ConversationStore.admission` 上排队的操作，超过 deadline 仍会等待并最终执行；
   - 会话删除的排队行为与修改前相同；
   - run 准入仍然有上限；
   - 控制实验：把默认值改回 20 s，第一条测试失败。

如果执行方认为会话删除也确实需要上限，单独写进 STATUS 的「需要决定」，附上理由，由维护者决定。

## 应修：20 s 这个上限的依据

报告里的依据是 fixture：300 次启动 p50 263 ms，最长 3.3 s。但 `waitForCompletedRuns` 等的是“已经对 UI 报了 done、但收尾还没 resolve”的 run，收尾包括 managed recorder 的两阶段提交：要等 Provider result、hook、diff 收敛，在大仓库上 diff 可能很慢。这个上限对**开关关闭的默认 App 路径**同样生效。超过 20 s 后，用户紧接着发的下一轮会以“同一会话已有一轮正在运行”失败，而原来是等它收尾完再开始。

需要给出依据，二选一：

- 从 `userData/performance` 的日常记录（只读，先快照再分析，不上传）里，取轮次结束 diff / recorder 提交耗时的分布，把上限设在 P99 以上并留出余量；
- 或者与 recorder 自身的收敛超时对齐，上限 = 该超时 + 余量。

在拿出依据之前，20 s 只能算一个暂定值，并在 status 里如实标注。

## 建议

把看门狗加进 `daemon-mode-timing.mjs` 和 `daemon-mode-smoke.mjs`：样本超过 10 s 没有 `providerStart` 时，调用 `daemon-stuck-run.mjs` 的现场采集逻辑。这样卡死一旦再次出现，就有证据可查，不用再靠审计推测。

## 下一步

先修 H1（先写失败测试和控制实验），并为 20 s 补上依据，或标注为暂定值。完成后停下等核验。H1 通过后，L3 的功能部分就可以关闭，然后进入 B4-L4。
