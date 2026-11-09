# B4-L3G：卡住的 run（G1）

核验输入：[REVIEW-BATCH4-L3G](REVIEW-BATCH4-L3G.md) 的「G1 有一个 run 卡住了」。目标：任何已提交的 run 在有界时间内进入可观察状态（Provider 已启动 / 带原因的 `run_failed` / App 显示结果未知），而不是无限停在中间。

## 结论

- **卡死现场没有复现。** 同一 daemon 连续 start：默认 prompt 20 + 200 次、约 3 s 的 paced prompt 40 + 6×5 次，全部进入终态（p50 约 263 ms / 约 3.3 s），没有一次触发 10 s 看门狗。所以这一项不是靠复现定位的，而是靠逐点审计「Provider 启动之前所有可以无限等待的位置」。
- **找到两处无上限等待**，都在 admission 里，且都在 `providerStart` 之前：等待同身份上一轮完成 action，以及等待已对 UI 报完成（`done`）但收尾 Promise 尚未 resolve 的上一轮。持有者不释放时，新一轮永远不会启动、不会失败，App 也就既看不到错误、也停不掉它 —— 与观测到的「没有文本、没有 `providerStart`、没有终态」一致。
- **两者都改成有界等待**（20 s，只在启动 run 的调用处生效，见 H1），超时后变成带原因的失败，经 dispatcher 记为 `run_failed` 并出现在 App 里。

## 审计：`providerStart` 之前的等待点

| 位置 | 今天是否有上限 | 结论 |
|---|---|---|
| `ContextAdmission.runMany` 等上一轮 action 结束（run 启动的最外层） | 无 | **本次改为有界**，超时 `run_admission_timeout` |
| `waitForCompletedRuns` 等 `done` 但未 `settled` 的冲突 run | 无 | **本次改为有界**，超时沿用既有「同一会话已有一轮正在运行」 |
| `shellEnvReady`（`warmShellEnv`） | 有（`SHELL_ENV_TIMEOUT_MS`） | 不变 |
| `getStartupManagedRecovery()` | 有（内部单飞 + 自身失败路径） | 不变 |
| `providerOperationGate.acquireOperation` | 非阻塞（`ok: false` 立即拒绝） | 不变，不是等待点 |
| Provider 启动本身 | Provider 自身超时 | 不在本次范围 |

## 修复

`src/main/context-admission.ts`

- 新增 `ADMISSION_DEADLINE_MS = 20_000` 与 `AdmissionOptions.admitDeadlineMs`（`Infinity` 表示不设上限）。
- `runMany` 在等上一轮时使用 `withinDeadline`；超时后 **只释放自己占的位**（`action` 从未运行），然后抛 `run_admission_timeout: 等待同会话上一轮收尾超过 <ms>ms，本轮尚未启动`。释放占位这一步是必须的：否则持有者之后释放，后续 run 还会排在一个空占位后面。
- `waitForCompletedRuns` 增加可选 `admitDeadlineMs`；不传时保持原来的无限等待（其它调用方语义不变）。

`src/main/bootstrap/run-admission.ts`

- 冲突 run 的收尾等待传 `settleDeadlineMs ?? ADMISSION_DEADLINE_MS`；超时继续走既有的 `同一会话已有一轮正在运行` 拒绝，文案对用户可读。`settleDeadlineMs` 只是为测试注入毫秒级边界，生产不传。

为什么是 20 s：正常收尾是毫秒级（本次 300 次启动 p50 约 263 ms，最长约 3.3 s）；20 s 已经远超任何真实收尾，同时远小于「用户以为卡死」。`providerStart` 之后不受影响，长时间运行的 run 不会被误杀。

链路：`startRun` 抛错 → daemon 端 run binding 抛出 → `RemoteDispatcher` 把观察到的错误写进 `run_failed` 的 detail（已有测试 `remote-dispatcher.test.ts`「marks failed with the observed error」覆盖）。daemon 的 `ContextAdmission` 与 App 是同一份 `createSessionState` 构造，默认值对两条路径都生效。

## 测试（先失败，后通过）

`src/main/context-admission.test.ts`

- `gives up waiting for a holder that never releases instead of queueing forever`：持有者永不释放 → 第二条在毫秒级以 `run_admission_timeout` 失败；持有者之后释放，第三条立即通过（证明超时那一轮没有留下幽灵占位）。
- `reports a UI-complete run that never settles as no longer waitable`：`done: true` + 永不 `settle` → 有界返回 `false`；同一输入不传 deadline 时仍在等待（控制组，证明 `false` 来自边界而不是恰好完成）。
- `keeps waiting without a deadline, so the bound is an explicit choice`：`Infinity` 时保持原语义。

`src/main/bootstrap/run-admission-parallel.test.ts`

- `stops waiting for a completed run whose teardown never settles`：真实 `ConversationStore` + `RunRegistry` + 生产 admission，注册一个 `done: true` 但 `settled` 永不 resolve 的冲突 run，第二条在 30 ms 边界内以「同一会话已有一轮正在运行」拒绝。

失败基线：修复前上述两条有界测试按 4000 ms 超时失败；实现后通过。控制实验：只把 `withinDeadline` 改回无条件 `await work`（保留测试），同样两条再次按超时失败，恢复后通过。

## 门禁

| 检查 | 结果 |
|---|---|
| `npx tsc -p tsconfig.node.json --noEmit` | 通过 |
| `npx vitest run src/main/bootstrap src/main/remote src/daemon src/host-runtime` | 124 文件 / 776 通过 |
| `npx vitest run src/main/context-admission.test.ts src/main/bootstrap/run-admission-parallel.test.ts` | 32 通过 |

## 未验证 / 限制

- **卡死本身没有复现**（300 次启动、两种 prompt、10 s 看门狗）。因此本次修的是「审计出的所有无上限等待」，不是「已观测现场的直接根因」。若真实成因不在这两处（例如 Provider 启动内部），仍会有同样的症状。
- 生产 daemon 里「真的卡住 20 s 后失败」的路径没有现场验证：需要在真实进程里制造永不释放的持有者，做不到无注入复现；当前证据是单元/准入层测试 + dispatcher 的既有错误映射测试。
- 复现工具 `scripts/daemon-stuck-run.mjs` 已提交：隔离 userData/workspace/HOME、`SCRY_HOST_DAEMON=1` + smoke provider、每轮 10 s 看门狗，触发时保存 ledger 事件、`activeRuns`、bind/stop 结果、timing 打点与 App 日志。默认 prompt 与 `--prompt "performance paced stream"`（约 3 s）两种负载都跑过。
- ~~共用同一 `ContextAdmission` 的其它路径（会话删除、fork 等）也随之有界~~ —— 已由 H1 撤回，见下节。

## H1：上限只属于启动 run（核验 [REVIEW-BATCH4-L3H](../REVIEW-BATCH4-L3H.md)）

G1 把 20 s 写成了 `ContextAdmission` 构造的**默认值**，于是所有实例都有界：不只 run 准入，还有会话账本 `ConversationStore.admission` 的 `'ownership'` 队列（`conversation-turns`、`conversation-lifecycle`、`conversation-store` 共 14 处，含 turn 写入与结算）、会话删除（`session-deletion`、`conversation.ts`）与 fork（`run-fork`）。那些排队的是写入：慢持有者（例如大会话的删除准备）之后排队超过 20 s 的 turn 结算会被直接拒绝，证据落不了盘，报错还写「本轮尚未启动」。

修法：

- `ContextAdmission` 默认值恢复为 `Infinity`（G1 之前的行为）。
- 新增 `admitRun(admission, keys, action)`，只是 `runMany` 加上 `ADMISSION_DEADLINE_MS`；`run-execution.ts` 的 run 准入改调它。`waitForCompletedRuns` 仍在 `run-admission.ts` 调用处显式传值。其余调用方不变，恢复无上限排队。
- 会话删除是否也该有界：不在本次范围，未改；如需要另行决定。

测试（修复前 4 条全部失败，修复后通过）：

| 测试 | 断言 |
|---|---|
| `context-admission.test.ts`「keeps a default admission queued past the run-admission deadline」 | 默认实例在 `ADMISSION_DEADLINE_MS + 5 s`（假定时器）后仍在排队、action 未执行，持有者释放后执行 |
| `conversation-store.test.ts`「waits past the run-admission deadline instead of refusing a queued write」 | 会话账本 `'ownership'` 队列同上，排队写入最终完成而不是被拒（修复前是 `rejected`） |
| `context-admission.test.ts`「bounds a run start that waits behind a holder at the run-admission deadline」 | `admitRun` 在上限处以 `run_admission_timeout` 拒绝且 action 未执行；超时那一轮不留幽灵占位 |
| `bootstrap/run-admission-deadline.test.ts` | `run-execution.ts` 的 run 准入经 `admitRun`，不再出现无界的 `contextAdmission.runMany(`（`startRun` 在此无法不经 Provider 驱动，所以用源码断言钉住调用处） |

控制实验：默认值改回 20 s → 前两条失败；`admitRun` 去掉上限 → 第三条失败；恢复后全部通过。

20 s 的依据：**暂定值**。现有依据只有 fixture（300 次启动 p50 约 263 ms、最长约 3.3 s）与 commit hook 自身 10 s 上限（`COMMIT_HOOK_TIMEOUT_MS`）；`waitForCompletedRuns` 等的收尾还包括轮次结束 diff，真实大仓库的分布尚未取证（需要读维护者本机 `userData/performance`，只读、先快照）。

门禁（本次，Linux 容器，root 用户）：`npx tsc -p tsconfig.node.json --noEmit` 通过；`npx vitest run src/main src/daemon src/host-runtime` 3097 passed / 2 failed / 3 skipped。两条失败（`db-outbox`「fails closed when the outbox directory cannot be read」、`desktop-directory-picker`「rejects unreadable directories before a grant」）在不含本次改动的基线上同样失败：容器以 root 运行，chmod 不可读对 root 不生效，属环境原因。第一次全量运行中 `daemon-run-lazy.test.ts` 出现过一次文件级加载失败（报错文本未保留），单独运行与第二次全量运行均通过，与本次改动无关但如实记录。
