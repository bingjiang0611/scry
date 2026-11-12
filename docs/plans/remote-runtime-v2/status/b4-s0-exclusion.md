# B4-S0 · `mutual-exclusion`：daemon 模式同 session 第二次启动

日期：2026-11-12。来源：维护者 macOS 上跑 B4-V `mutual-exclusion`，`same-session-excluded` 一步开关关闭对照判为 `refused`，daemon 模式判为 `unknown`。场景与判定见 [b4-s0-scenarios.md](b4-s0-scenarios.md)。

## 原因

产品两种模式的**拒绝本身一致**，**App 看到的结果不一致**。判定脚本没有判错，不需要改。

- 进程内：第二次启动在 `run-admission.ts` 里发现同一 session 仍有未结束的 run（`waitForCompletedRuns` 对未 `done` 的 run 立即返回 false），抛 `AgentRuntimeError('同一会话已有一轮正在运行')`，`agent:start` 直接 reject，没有 run。
- daemon（`61106a4` 之前）：App 提交 intent 后只等 daemon 的 `bound` 标记就返回，而 `remote-run-binding.ts` 在调用规范管线（准入就在里面）**之前**就写了 `bound`。真实 daemon 复现：第二次 `start` 约 80 ms resolve 成 `{ runId: 'remote-run-…-1', externalSessionId: <第一轮的 session> }`；不到 1 s 后 ledger 里该 run 是 `bound`、`session(resumed)`、`settled failed`、`run_failed 同一会话已有一轮正在运行`。run 从未登记，窗口里 `done` 一直是 `null`。没有并行执行（smoke Provider 没收到第二个提示词），所以不是互斥漏洞。
- 脚本因此看到 `startError` 为空、两次观察 `done` 都是 `null`，`classifySecondStart` 只能给 `unknown`。这是对的：resolve 了却永远看不到结局的启动，不能记成拒绝。

## 修复

由 trust-gate 那条 lane 的 `61106a4`（「answer a daemon start after admission」）一并修复，原因相同：daemon 的 `start` 现在等到 `admitted` 标记（`remote-run-binding.ts` 的 `onStarted`），或者先读到本 run 的 `run_failed` / `run_cancelled`，后者以 daemon 自己的消息 reject（`src/main/daemon-run-admission.ts` 的 `DaemonRunRefusedError`）。本文只补同 session 场景的回归测试，不再改产品代码。

## 与进程内仍不同的一处：错误类型名

消息相同，类型名不同。Electron 把 handler 抛出的错误按 `error.toString()` 传给窗口：

| 模式 | 窗口收到的 `error.message` | `ipcErrorMessage` 去掉包装后显示 |
| --- | --- | --- |
| 进程内 | `Error invoking remote method 'agent:start': AgentRuntimeError: 同一会话已有一轮正在运行` | `AgentRuntimeError: 同一会话已有一轮正在运行` |
| daemon | `Error invoking remote method 'agent:start': Error: 同一会话已有一轮正在运行` | `同一会话已有一轮正在运行` |

原因：ledger 只记录消息，不记录错误类型；而管线的拒绝有两种类型（会话冲突是 `AgentRuntimeError`，trust 拒绝 `MCP 配置无法安全执行…` 是普通 `Error`），`61106a4` 统一用普通 `Error`，对 trust 拒绝完全一致，对会话冲突差一个前缀。B4-V 判定不受影响（任何 `startError` 都按拒绝处理，再看 ledger 终态）。要完全一致有两条路，需要维护者决定：

1. daemon 在失败进度标记里带上错误类型名，App 按名重建同类错误（协议多一个字段，`daemon-run-runtime.ts` 已接近体积上限）。
2. renderer 的 `IPC_WRAPPER`（`src/renderer/constants/ipc-error-copy.ts`）同时去掉 `AgentRuntimeError:` 前缀，两种模式显示相同文字（也改变进程内现有文案）。

## 测试

- `src/daemon/host-process-exclusion.test.ts`（真实 daemon，临时 userData/workspace，smoke Provider，App 自己的 `DaemonRunTransport` + `DaemonRunRuntime` + `createDaemonRunSurface`）：第一轮 `native composer b4v hold …` 在线并有 session；同 session 第二次启动 reject，`DaemonRunRefusedError`，消息为进程内准入的 `同一会话已有一轮正在运行`；第一轮不受影响，smoke Provider 没收到被拒的提示词；新 session 第二次启动并行完成且无错误；最后停掉第一轮。
- 对照：把 `remote-run-binding.ts`、`daemon-run-runtime.ts`、`daemon-run-cursor.ts`、`daemon-run-surface.ts` 还原到 `61106a4^` → 失败（`expected true to be false`，第二次启动 resolve）；恢复后通过。
- `scripts/b4v/outcomes.test.mjs`：补一条用例，固定修复前后两种 daemon 观测的判定（修复前的形状是 `unknown`，现在是 `refused`）。判定器未改。

## 实际运行（Linux 容器，root，有其他 lane 并行）

- `npx vitest run src/daemon/host-process-exclusion.test.ts scripts/b4v src/daemon/host-process-trust-gate.test.ts src/main/daemon-run src/main/bootstrap/daemon-run src/main/remote/remote-run-binding`：33 个文件、192 个用例通过。
- `npm run typecheck`：通过。
- 本次只新增测试和文档，没有改 `scripts/performance-paths.json` `sources` 里的文件，所以未跑 `performance:measure`。

## 未运行 / 未验证

- macOS 上的 B4-V 重跑未执行（本容器不是目标机）：

  ```bash
  node scripts/b4v-scenarios.mjs --only mutual-exclusion --out /tmp/b4v-excl.json
  ```

  预期：`same-session-excluded` 两边都是 `refused`（daemon 模式 `startError` 为 `…Error: 同一会话已有一轮正在运行`，ledger 终态 `failed`，`recordedDespiteError: false`）；`new-session-observed` 两边都是 `parallel`；`matches-in-process` 通过。
- 真实 Provider、iOS 未运行。
- 另见：`daemon-run-runtime.ts` 在本步 trace 读取之前就把 ledger 终态写入 cursor，视图可能在最后一段文字应用之前显示 `done: true`（单元测试 `daemon-run-stream.test.ts` 依赖时序才通过）。本次未改，记为待办。
