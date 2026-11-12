# B4-S0 · trust-gate：daemon 模式下被拒绝的启动

日期：2026-11-12。来源：维护者在 macOS 上跑 B4-V 场景 `trust-gate`（[运行手册](b4-s0-scenarios.md)，脚本 `scripts/b4v/scenarios/trust-gate.mjs`）。

## 现象

仓库 `.codex/config.toml` 的 MCP server env 带 `NODE_OPTIONS`，trust gate 必须拒绝。

- 开关关闭对照（进程内流水线）：`start` 被拒绝，错误点名 `NODE_OPTIONS`。正确。
- daemon 模式：`start` 被接受并返回 runId，30 s 内没有收尾，没有 Provider 输出；ledger 状态不是 `settled`。

## 原因

trust gate 本身在 daemon 里照常执行，而且是同一份代码：daemon 的 run 走与 App 相同的 `prepareRunAdmission` → `ensureMcpExecutionAuthorized`（`src/main/bootstrap/run-admission.ts`、`trust.ts`），在 Provider 启动之前、run 登记之前抛出 `MCP 配置无法安全执行：MCP server b4v_probe 使用可改变执行目标的 env：NODE_OPTIONS`。dispatcher 把这次 intent 记为 `run_failed`（detail 即上面的原文）。用真实 daemon 复现时 ledger 是 `intent_recorded → run_dispatched → run_progress{bound} → run_progress{settled, failed} → run_failed`，没有 Provider 输出。仓库配置没有被执行；这里的 `run_dispatched` 是 dispatcher「每个 intent 只交给执行器一次」的栅栏，不是 Provider 启动。

问题在 App 这一侧的应答时机和收尾：

1. remote run binding 在调用流水线**之前**写 `bound` 标记（ledger runId ↔ 规范 runId）。App 的 `DaemonRunRuntime.start` 一看到 `bound` 就把 runId 交给 renderer，比进程内 `agent:start` 早：进程内要等准入（工作区、会话冲突、Codex Hook / OpenCode plugin / 仓库 MCP 的 trust 重验）和登记完成才返回，准入失败时直接 reject。所以 daemon 模式下被拒绝的启动表现为「已接受」。
2. 这个 run 从未在 daemon 登记，trace 读不到快照；App 的视图（`view(cursor)`）在没有快照时返回 `null`，`focusedRunSnapshot` 一直是 `null`，窗口看不到 `done` 也看不到错误，于是一直挂着。ledger 里其实已经是 `failed`。

## 修复

不新增第二套 trust 实现，也不在 App 里预检：准入仍只在 daemon 里由原流水线执行，fail closed 不变。改的是「App 什么时候回答 start」和「被拒绝的 run 怎么收尾」。

- daemon：`remote-run-binding.ts` 在流水线登记 run 后（`onStarted`，与进程内 `agent:start` 返回同一时刻）写一个 `admitted` 进度标记。其余标记不变；手机端和 iOS 对未知 `event` 原本就忽略。
- App：新模块 `src/main/daemon-run-admission.ts`。`start` 等到绑定之后继续等准入结果：
  - 读到本 run 的 `admitted`（或它的 trace 快照、输出、`settled`）→ 照常返回 runId；
  - 先读到本 run 的 `run_failed` / `run_cancelled` → `start` 以 daemon 的原始消息 reject（普通 `Error`，经 IPC 后与对照组的文字相同），不保留游标、不发通知，与进程内「没有 run」一致；
  - ledger 已终止且所有条目已读、仍没有准入证据 → 同样按拒绝处理（消息 `run_failed`），不空转。
- 准入等待上限 30 s（`DEFAULT_ADMIT_BUDGET_MS`，大于流水线等待同会话上一轮的 20 s）。超过上限时 run 以「已绑定」交出；之后若被拒绝，视图返回一个 `done: true`、`error` 为 ledger 原因、`items: []` 的终态（`refusedView`），并向窗口发进程内同样的 `agent:error { runId, message }`。没有 run 会无限期保持未收尾。
- `daemon-run-runtime.ts` 原有的绑定等待循环移进新模块（文件仍在 20 KB 以下）；`src/daemon/host-process.ts` 与 `src/main/index.ts` 没有改动。

## 测试

| 测试 | 内容 |
| --- | --- |
| `src/daemon/host-process-trust-gate.test.ts` | 真实测试 daemon（`startTestDaemon`，smoke Provider，临时 userData/workspace/HOME）+ App 自己的 daemon run surface（`createLazyDaemonRunSurface`，即 daemon 模式下 `agent:start` 调的那一层）。按场景三步：安全配置 → settled 且 ledger 有 `admitted`；NODE_OPTIONS 配置 → `start` reject，消息与同一 HOME/cwd 下直接调用 `ensureMcpExecutionAuthorized` 的结果**完全相同**，ledger 为 `run_failed`（detail 同文）、无 `run_settled`、无 `admitted` / `started` / `result`；换成另一份安全配置 → 重验后 settled |
| `src/main/daemon-run-admission.test.ts` | 脚本化 daemon：拒绝 → reject 且不留 run、不发通知；`admitted` → 返回；别的 run 的 `admitted` 不算本 run；超过准入上限后才被拒绝 → 视图 `done` 带原因、发一次 `agent:error`；终止但无原因 → 按拒绝处理且不空转 |

先失败后通过：

- 修复前（只有测试）：`host-process-trust-gate` 失败，`promise resolved "{ runId: 'remote-run-…' }" instead of rejecting`。
- 对照 1，撤回 App 侧修复（含 `admitted` 标记）：最终测试先在安全配置的 `admitted` 断言处失败；去掉这两条 `admitted` 断言后，失败在 `expected 'accepted remote-run-…' to be 'MCP 配置无法安全执行：…NODE_OPTIONS'`。
- 对照 2，保留修复、把 `run-admission.ts` 里的 `ensureMcpExecutionAuthorized` 调用临时换成 `null`：失败，同上（不安全配置被接受）。两项对照都已还原，`run-admission.ts` 不在提交里。

## 本容器实际运行（Linux）

- `npx vitest run src/daemon/host-process-trust-gate.test.ts src/main/daemon-run-admission.test.ts`：通过。
- 受影响范围 `src/main/daemon-run* src/main/bootstrap/daemon* src/main/bootstrap/agent-runtime-ipc* src/main/bootstrap/conversation-daemon-send src/main/remote/remote-run-binding* src/main/remote/host-controller* src/main/remote/desktop-client* src/main/remote/desktop-lane* src/main/remote/inner-mtls* src/daemon src/host-runtime`：81 个文件、408 个测试通过。
- 全量 `npx vitest run`（root 用户容器）：6116 个测试中 6105 通过、5 skip、6 失败。6 个失败都与本次改动无关、单独重跑时 5 个仍失败：2 个 Electron/Chromium fixture（`Running as root without --no-sandbox is not supported`），2 个「不可读目录」断言（root 不受目录权限限制：`db-outbox`、`desktop-directory-picker`），`scripts/owned-app-processes.test.mjs` 的 TERM 回收；`performance-counters/concurrency-trace-main` 只在全量并行时失败，单独重跑通过。
- `npm run typecheck`：通过。`node scripts/daemon-ipc-matrix.mjs`：`IPC matrix up to date (172 channels)`（没有新增或改路由的 channel）。
- 未改 `scripts/performance-paths.json` 的 `sources` 中的文件，未跑 `performance:measure`。

## 未运行

- B4-V 场景本身（构建后的真实 App，经 CDP），macOS 与 Linux 均未在本次运行。
- 真实 Codex（付费 Provider）未驱动；测试只用 smoke Provider。
- daemon 模式 start 现在要等准入，发送到首字的时间会包含准入耗时（与进程内一致）；没有做毫秒测量。

## macOS 复跑

```sh
npm run build
npx @electron/rebuild -f -w better-sqlite3
node scripts/b4v-scenarios.mjs --only trust-gate --out /tmp/b4v-trust.json
# 回到 Node 单测前：npm rebuild better-sqlite3
```

预期：`trust-gate-control` 与 `trust-gate` 的三步结果一致（settled / refused / settled），`unsafe-change-refused` 的消息点名 NODE_OPTIONS 且无 Provider 输出，`refusal-recorded-as-failed` 为 `failed`。
