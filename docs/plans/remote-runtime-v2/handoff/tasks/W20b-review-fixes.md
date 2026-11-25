# W20b · W20 核验返修

执行方：做 W20 的那个执行方，继续在原来的 worktree（本地分支 `exec/W20`）里工作，推送到 `claude/scry-performance-optimization-46ngcf`。规则和 W20 任务单一样：不开 PR，不合并 main，不 force push，不 rebase。iOS 不在范围内，只做 Mac 和桌面端。

核验方 2026-11-25 在 `3016f037` 上做了只读评审，发现 4 个阻塞项和 10 个应修项。每一项都要先写失败测试（场景下面写了），再修，每项单独提交。测试只用临时 HOME。

## 阻塞（合并 main 前必须修）

**R1 · outbox 被一个会话卡住，所有会话都派发不了**（`effect-outbox.ts:79-106`、`remote-dispatcher.ts` 里 `#pumpOutbox` 的 defer 分支）
- **原因**：领取时不分会话，只取全局最早的一条（`ORDER BY causation_seq LIMIT 1`）。被 defer 或 retry 放回 `pending` 的那一条立刻又会被领到。
- **场景**：会话 A 有一个正在运行的 run，还有一条排队的 D1 条目；会话 B 提交了一个新 run。B 的 run 一直领不到，要等 A 的运行结束才能派发。挂起的条目、因为 Provider 还在认证而被 requeue 的条目，也会这样卡住所有会话。
- **修法**：给 outbox 加 `available_at` 列，defer 和 retry 时写入，领取时按它过滤，退避时间按 `retryEffect` 算出的 `delayMs` 来定；同时在同一轮 pump 里跳过已经 defer 过的条目。

**R2 · 重启之后，排队的条目丢失，会话一直卡住**（`dispatch-ledger-snapshot.ts:29-35`）
- **原因**：重建快照时，`queued` 被映射成了 `cancelled`，原始请求内容也丢了。重启后队首被放行：authority 写了 `admitted_and_dispatched`，但台账认为这个 run 已经取消，`markDispatched` 于是抛错；pump 把这个错误理解成「别人已经派发过了」，直接调用了 `succeed`。最后这个 run 永远停在 `dispatched`，从没真正执行。
- **修法**：
  - 快照里把 `queued` 映射成 `recorded`，并保留原始请求内容；
  - 只有台账确认这个 run 已经是 dispatched 或终态时，才调用 `succeed`，其他情况都经 authority 记一个终态结果；
  - 测试：排队、SIGKILL、重启之后，这个条目能执行，而且只执行一次。

**R3 · Qoder：新对话会接到别的对话的原生会话上**（`qoder-run.ts:62-73`）
- **原因**：会话池的 key 是 `continuationKey ?? unverified:<cwd>` 加 `resume ?? 'fresh'`。continuationKey 是 Provider 级的，不区分对话，所以同一工作区里两个新对话会拿到同一个 `fresh` key。
- **后果**：对话 B 的提问进了对话 A 的上下文。而同一对话真正的第二轮带的是 `resume=<sid>`，key 不一样，反而复用不到。现有测试 `qoder-session-run.test.ts:57` 断言的正是这种错误行为，要改正。
- **还有一个问题**：`openQuery` 把 `canUseTool`、进程退出回调、taskControl、pid 都绑定在第一个 run 上。第二轮的权限请求会发给已经结束的 run 1，进程退出会被忽略。
- **修法**：
  - `fresh` 会话一律不复用；
  - 第一轮拿到原生 id 之后，用这个 id 作为别名登记；
  - 回调改成通过「当前这一轮」间接转发；
  - 测试：两个新对话互不串话；同一对话的第二轮复用同一个进程；第二轮的权限请求发给第二轮。

**R4 · Antigravity：同一个 key 第二次 acquire 时，会关掉正在运行的进程**（`session-host.ts:85-95`）
- **原因**：条目正忙时，代码调用 `release(key, 'replaced')` 把它关掉了。注释里写的「并发 acquire 已经串行化」并不成立。
- **修法**：条目正忙时另开一个进程，或者等它空闲，绝不关闭正在运行的条目。测试：同一个项目里同时开两个新对话，两个都能正常跑完。

## 应修（这一轮一起修）

- **R5**：dispatcher 用 canonical runId 去查以 ledger runId 为 key 的台账（`createLedgerIdForSubmit`），对非 UUIDv4 的 id 会查不到，最后 run 被静默丢掉。修法：派发前先把 canonical id 映射回 ledger id。另外，台账被 fence 时，不要把抛错当成 succeed。还要把 `submitReceivedIntent` 里「outbox 行先提交、台账后写入」中间的 await 窗口关掉：要么先记台账，要么在台账写入之前这一行不可领取。
- **R6**：没有租约过期回收，也没有真正的退避。
  - 按 `claimed_at` 加租约时长回收卡在 `running` 的行；
  - 领取之后 `beforeDispatch` 抛错时，要把这一行放回去；
  - 退避时间写进 `available_at`（和 R1 一起做）。
- **R7**：worker 路径上的 `question.respond` 永远失败。执行器读的是 `.response`，但 payload 里的字段是 `answerId` / `answerPayload`（`host-controller-execution.ts:222-231`，`orchestrator.ts:367-374`）。另外，停止类副作用不能排在同一会话的 `run.start` 后面，要单独领取，或者优先领取。
- **R8**：`SQLITE_BUSY` / `SQLITE_LOCKED` 被当成了「非致命逻辑错误」，结果写下了永久拒绝的回执。确定性 id 的命令被拒一次就永远进不了终态。修法：BUSY 和 LOCKED 按可重试处理，不写回执（`store-fault.ts:7-15`、`rejectAfterRollback`）。
- **R9**：D5 的检查点会写进用户自己的仓库，还会拖慢运行收尾。
  - 只在受管 worktree 里抓检查点（`run-completion.ts:229`），或者改成用户显式开启才抓；
  - 不要在收尾路径上做全量 `add -A` 和重新哈希；
  - 未被忽略的未跟踪文件不要写进对象库；
  - 实现 `forgetCheckpoint` 的调用方，或者给检查点设保留上限，让 ref 能被回收；
  - 倒回之前先给当前状态存一个检查点，同一个 worktree 里有其他运行在进行时，拒绝倒回。
- **R10**：D4 的会话文件写完之后，`recordSessionMetadata` 抛错，接口就报失败，可文件其实已经改了；返回 `unavailable` 时也被静默丢掉，之后也没有对账。修法：写事件失败只记日志，加入对账队列，接口照常返回成功；启动对账时补写缺失的事件。
- **R11**：停止一个排队中的 run，结果变成了「挂起」，而不是「取消」，它和同队列的其他条目都会一直挂着。修法：停止排队中的 run 就取消这一条，不挂起它的兄弟条目。
- **R12**：Qoder 会话池的两个问题：
  - 不重建崩溃的会话：失败的轮次之后照样 `release`，`acquire` 也不检查会话是否还活着；
  - 忙碌的 key 再被 acquire 时，`entries.set` 会覆盖旧条目，旧条目的空闲计时器到点后关掉的是新条目，被覆盖的进程也成了孤儿。
- **R13**：保留期的细节。
  - 本机 App 的命令用的是 actor `system`，回执 30 天后会被清掉。要换成明确的用户 actor，或者把本机用户命令也算作永久保留。
  - 目录扫描的命令 id 去掉了 rev，内容按 A→B→A 变化时会被当成重复命令。
  - `orchestration-maintenance.ts` 吞掉了 prune 的致命 IO 错误，应该和其他地方一样触发 fence。
- **R14**：有三个文件超过了 20,000 字节：`src/daemon/host-process.ts`（20,900）、`src/preload/index.ts`（20,025）、`src/preload/index.test.ts`（20,072），要拆分。

小问题顺手处理：
- `p4-2-recovery.test.ts` 的断言被放宽了：recovery 的 pending 分支没有检查 lifecycle，结果已经派发的 run 也被列成了可派发。修代码，恢复原来的断言。
- `ProviderSessionHost` 把别名也计入了会话上限。
- `rejectAfterRollback` 里的致命错误分支走不到。
- V9 迁移在 outbox payload 是坏 JSON 时会中止启动。

## 报告纠偏

在 W20 的报告里改正这些说法：
- 「只领取 `provider.run.start`」；
- 「退避 100·2ⁿ ms」；
- 「`question.respond` 由 worker 执行」；
- 「用户回执永久保留」；
- 「host-process.ts 19,972 字节」；
- 「排队条目重启后仍在」；
- Qoder「同会话第二轮 2,321 ms」：要说明当时测的是不是 `fresh` key 被复用的情况，必要时用真实的第二轮重新测。

## 验收

- R1–R14 每项都有失败测试，修完之后测试通过。
- 全量检查：
  - typecheck
  - `--strict` 导入检查，模块数不超过 192
  - 全量 vitest
  - `check:cli-runtime`
  - 开发版和打包版冒烟
- 再开一个只读子 agent 做第二轮评审，修掉阻塞项。
- 报告写在 `reports/W20b.md`，第一行写状态。
