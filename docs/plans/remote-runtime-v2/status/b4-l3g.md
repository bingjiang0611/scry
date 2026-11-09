# B4-L3G：卡住的 run（G1）

核验输入：[REVIEW-BATCH4-L3G](REVIEW-BATCH4-L3G.md) 的「G1 有一个 run 卡住了」。目标：任何已提交的 run 在有界时间内进入可观察状态（Provider 已启动 / 带原因的 `run_failed` / App 显示结果未知），而不是无限停在中间。

## 结论

- **卡死现场没有复现。** 同一 daemon 连续 start：默认 prompt 20 + 200 次、约 3 s 的 paced prompt 40 + 6×5 次，全部进入终态（p50 约 263 ms / 约 3.3 s），没有一次触发 10 s 看门狗。所以这一项不是靠复现定位的，而是靠逐点审计「Provider 启动之前所有可以无限等待的位置」。
- **找到两处无上限等待**，都在 admission 里，且都在 `providerStart` 之前：等待同身份上一轮完成 action，以及等待已对 UI 报完成（`done`）但收尾 Promise 尚未 resolve 的上一轮。持有者不释放时，新一轮永远不会启动、不会失败，App 也就既看不到错误、也停不掉它 —— 与观测到的「没有文本、没有 `providerStart`、没有终态」一致。
- **两者都改成有界等待**（默认 20 s），超时后变成带原因的失败，经 dispatcher 记为 `run_failed` 并出现在 App 里。

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
- 共用同一 `ContextAdmission` 的其它路径（会话删除、fork 等）也随之有界：持有者永不释放时，它们从「无限转圈」变成 20 s 后带原因失败。这是行为变化，记录在此。
