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

## H1.1 20 s 的依据（本机日常记录）

方法：只读。先把 `<userData>/performance` 整目录 `cp -p` 到 `/tmp/perf-snap`（123 个文件、34 MB），再离线解压解析；不上传、不打印提示词/路径/正文，只取操作名、阶段名与毫秒数。数据是本机真实 App（packaged）的日常记录，10 个 session，2026-10-19 → 2026-11-09，build 0.2.206…0.2.239。

`waitForCompletedRuns` 等的是「已对 UI 报 done 的 run 收尾」，最接近的测量是 `agent.terminal_finalize`（`provider_terminal → database_projected`，含轮次结束 diff 与 archive/recorder 提交）。单位 ms：

| 指标 | n | P50 | P95 | P99 | 最大 |
|---|---|---|---|---|---|
| 轮次收尾合计 `agent.terminal_finalize` | 131 | 733.2 | 2911.0 | 4326.2 | 5149.9 |
| 同一指标，仅最新 build 0.2.239 | 37 | 1096.1 | 1963.9 | 2494.8 | 2556.9 |
| 其中轮次结束 diff（`diff_complete` 段） | 131 | 349.5 | 2790.5 | 3582.1 | 4569.3 |
| 其中 recorder/archive 提交（`archive_committed` 段） | 131 | 20.3 | 739.8 | 1367.4 | 1397.3 |
| `ipc.agent:gitDiff`（diff 读取 IPC） | 127 | 303.3 | 844.3 | 1087.1 | 3429 |

同一收尾里的其它段（只有较新的 39 条样本有打点）：`catalog_settled` P50 27.7 / P95 32.8，`renderer_terminal` P50 68.5 / P95 116.6，`terminal_progress_settled` P50 20.0 / P95 52.3，`turn_diff_joined` P50 370.0 / P95 583.7。

结论：观测到的最长收尾是 5.15 s，P99 是 4.33 s；20 s 是观测最大值的约 **3.9 倍**、P99 的约 **4.6 倍**。轮次收尾的大头确实是轮次结束 diff（最大 4.57 s），其次是 archive/recorder 提交（最大 1.40 s）。**P99 与最大值都远离 20 s，不需要停下或调整上限。**

限制：样本全部来自本机这几个仓库，不代表超大 monorepo 或网络文件系统；`agent.terminal_finalize` 只有 `completed` 记录（131/131），失败或中断轮次的收尾尾巴没有被这组数据覆盖；总量混了多个 build，因此另列了最新一版。`control.settled` 与 `database_projected` 不是同一个对象，这里是代理指标，不宣称完全等价。

门禁（维护者侧，Linux 容器，root 用户）：`npx tsc -p tsconfig.node.json --noEmit` 通过；`npx vitest run src/main src/daemon src/host-runtime` 3097 passed / 2 failed / 3 skipped。两条失败（`db-outbox`「fails closed when the outbox directory cannot be read」、`desktop-directory-picker`「rejects unreadable directories before a grant」）在不含本次改动的基线上同样失败：容器以 root 运行，chmod 不可读对 root 不生效，属环境原因。第一次全量运行中 `daemon-run-lazy.test.ts` 出现过一次文件级加载失败（报错文本未保留），单独运行与第二次全量运行均通过，与本次改动无关但如实记录。

复核（本轮，macOS 15 / arm64，非 root，cherry-pick `cb14dbd` + `a2fe168` 之后）：

| 检查 | 结果 |
|---|---|
| `npx vitest run src/main/context-admission.test.ts src/main/conversation-store.test.ts src/main/bootstrap/run-admission-deadline.test.ts src/main/bootstrap/run-admission-parallel.test.ts` | 4 文件 / 52 通过，退出码 0 |
| `npm run typecheck` | node + web 两套均通过，退出码 0 |
| `npx vitest run src/main src/daemon src/host-runtime` | 345 通过 / 3 skipped（P0/P1/BILLING 探针），3099 通过、退出码 0；`db-outbox`「fails closed when the outbox directory cannot be read」与 `desktop-directory-picker`「rejects unreadable directories before a grant」在非 root 下通过 |
| `npm run build` + `node scripts/daemon-mode-smoke.mjs` | 构建退出码 0；12 步全 `ok: true`（`streaming` 20 次到达、间隔中位数 152 ms） |
| `npm run test:desktop-remote` | 退出码 0（会话打开、host、session parity、composer、settings、lifecycle 各组全 true） |
| `npm run install:mac:dev` | 退出码 0：全量 `npm test` 621 文件 / 5659 通过 / 4 skipped，打包、`check:packaged-app`、`smoke:electron` 全过，已装到 `/Applications/Scry.app`（0.2.237，原 App 备份为 `/Applications/.Scry.app.backup`），未重启用户正在使用的实例 |

附带修了两条**本次改动无关的既有门禁红灯**（都会挡住宿主验证与安装）：

| 红灯 | 引入提交 | 原因 | 修法 |
|---|---|---|---|
| `scripts/session-concurrency-bench.test.ts`「names scenarios that exist in the offline fixture」 | `118dbf6e` | 断言在 `smoke.ts` 里找场景 prompt 字面量，而 `'performance long stream'` 随 paced/long stream 抽取搬到了 `smoke-paced-stream.ts` | 把该模块并入被扫描的 fixture 源，断言强度不变（仍要求每个场景 prompt 真实存在） |
| `check-packaged-app`「packaged daemon supervisor 未使用 Electron Node 模式」 | `6fa005eb` | 入口被 rollup 拆成 `chunks/supervisor-*.js` 再 re-export，守卫只读了 `out/main/daemon-supervisor.js` 一个文件 | 守卫顺着入口自己的相对 import 收集同一打包目录内的 chunk 再断言；控制实验：改回只读入口后立刻再次失败 |

两条都用“回到出问题的输入 → 失败、修复后 → 通过”验证，未删断言、未放宽范围。

合并说明（核验方）：`check-packaged-app` 的同一问题在 `claude/scry-performance-optimization-46ngcf` 上由 `0448e68` 先行修复（`scripts/packaged-main-graph.mjs`，带单测；被 import 的模块缺失时报错而不是跳过）。两分支合并时保留 `0448e68` 的实现，本节表中的修法描述与之等价。
