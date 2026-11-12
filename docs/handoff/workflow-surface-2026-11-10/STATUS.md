# 第五轮进行中（E1 未通过，见 reports/E1.md）

**第四轮四包都已执行完毕并 push，等审查方核验。D1 未通过、D3 据此不改、D2 的跨版本对照缺一半、D4 有一道门禁被本机负载拖成超时。**

> **维护者决定（2026-11-11）：本机不使用 Claude CLI，所有依赖 Claude 真实运行的条目不再推进。** 受影响：B（Q1 到 Q11、真实夹具）、C 的运行中 / 失败 / 停止截图、E2、E3 的“按名称运行”、G4 的“带真实 workflow 行的会话”。它们保持未验证，不是阻塞待解除。执行方不要再为它们探测网关、找凭据或想办法启动 Claude。

第四轮（D1–D4，Qoder 守护进程迁移的真机验证，见 [R4.md](R4.md)）报告：[D1](reports/D1.md)、[D2](reports/D2.md)、[D3](reports/D3.md)、[D4](reports/D4.md)。

- **D1（未通过）**：[reports/D1.md](reports/D1.md)。本机 CLI 1.1.86 + SDK 1.0.59 在独立 test 实例上跑真实轮次。通过：普通一轮（3 个工具、文件足迹、用量、diff、`.scry` 记录 0.2.63）、审批允许、managed recorder 的 `managedRunId` 与界面 run ID 一致、MCP 读取（空态、无残留守护进程）、App 退出无长期残留。
  失败：**停止（或在 Provider 给出 session id 前取消/`/plugins reload`）之后，同一工作区的后续轮次被 `Scry trace 仍有 1 轮待恢复` 永久拦住**，重启也不能恢复（`d1n`），因为 pending 记录是 `missing_provider_session_id` 且带着 22 条 hook 证据，`trace-turn-progress.ts` 的 `isProviderlessTerminalTurn` 永远判为可恢复却无法恢复；`/plugins reload` 在 Provider 侧成功（5 个插件、84 条命令）但 recorder 报 `requires an authoritative Provider session id`；两个会话不能真正同时跑，切到新会话会丢掉前一轮的证据。停止本身会先等 4 秒再强制结束，守护进程在 8–13 秒内退出。
  未验证：审批拒绝、分支、后台子 Agent（`Task×2` 启动后 `Operation aborted`）、MCP OAuth。
- **D2（对照缺一半）**：[reports/D2.md](reports/D2.md)。本分支 10 轮真实发送，点击到第一个回答 token 中位数 16.1 秒（14.2–31.8 秒，1 分钟负载 30–60，串行）。`origin/main` 对照没测成：配 CLI 1.1.86 直接 `exited with code 42`；配 CLI 1.1.80 时版本探测 5 秒超时、发送按钮禁用（当时负载 111）。`~/.qoder/logs` 10 轮增长：`runs/` +21 目录、`sdk-daemon-*.log` +11 个 / +13,752 B。按 CLAUDE.md 属 L2，不是 L3。
- **D3（不改）**：[reports/D3.md](reports/D3.md)。D1 未通过，按 R4 的规定不改兼容性清单，`src/main/provider-compatibility-manifest.ts` 本轮零改动（`git diff` 行数 0），也没有产品代码改动。
- **D4（三道通过、一道被负载拖垮）**：[reports/D4.md](reports/D4.md)。干净 worktree（`/tmp/scry-d4`，按 `package-lock.json` 重装依赖）上：`typecheck` 0、`test:renderer:ui` 0、`pack:artifact` 0（产物 301,960,323 B ≤ 346,030,080 B，`qoderSdk: true`、`qoderBundledCli: false`、312 个运行时依赖）；`test:unit -- --maxWorkers=1` 退出码 1，18 个用例全是 `Test timed out in 5000ms`，用 `origin/main` 做对照同样 5 秒超时，判定为负载所致，未改超时。


**这对 Workflow 面板意味着什么**：面板的阶段与 agent 明细来自 Claude Code 未公开的 `workflow_progress` 字段，字段形状是从 CLI 2.1.251 与 2.1.322 的程序包里读出的，从未在真实运行上核对。已有的保护是：字段缺失时面板显示 unavailable，没有终态时显示状态未知，识别只看结构化字段。若真实格式不同，最坏情况是 Claude 会话里面板显示 unavailable 或明细不全，不会误判其他 Provider（第二、三轮已用真实 Codex、Pi、OpenCode、Qoder 运行确认）。


第三轮（Q1–Q4，验证 Qoder SDK 1.0.17 → 1.0.57 的真机效果并补跑 Qoder 与 rotom）已在 macOS 本机完成并 push，做法见 [R3.md](R3.md)。四个包的报告：[Q1](reports/Q1.md)、[Q2](reports/Q2.md)、[Q3](reports/Q3.md)、[Q4](reports/Q4.md)。

- **Q1**：只升 SDK 不够。本机 CLI 1.1.86 与 1.1.81 都报 `sdk_worker_removed`、`exit 42`；换 CLI 1.1.80 后 Qoder 在真实 App 里跑通（29.8k in / 3 out / 6.3s，`workflow_activity` 0）。这与 R3 表格里「1.0.57 配套 CLI 1.1.81」不一致，CLI 自己给出的上界是 1.1.80 或更早。
- **Q2**：升级后的日常路径逐项通过——读写文件与 Bash、审批允许与拒绝、停止（无残留进程、显示「本轮已中断」）、重启后恢复、分支会话、`TaskCreate/TaskUpdate/UpdateGoal`、MCP。两处如实说明：Provider 对失败的子 Agent 也报 `completed`；登录失效提示未验证。
- **Q3**：Qoder 8 轮真实运行的 `workflow_activity` 全为 0；真实脱敏事件做成夹具 `src/main/workflow-wire-fixtures/qoder-background-agent.ts` 并带回放测试（负对照放宽判据后 3 条失败）。rotom `0.1.27-main.655c35f2` 跑出 `kind: subagent` 与 `kind: workflow` 两种异步运行，后台卡片都显示、Workflow 面板空态。
- **Q4**：干净 `npm ci` 后五道门禁全部 EXIT=0，`pack:artifact` 的产物含 Qoder SDK 与 `cross-spawn`，证实上一轮那次失败是共享 `node_modules` 所致。

**待维护者决定的一条**：兼容性清单仍把 Qoder CLI `>=1.1.60 <1.2.0` 标为受支持，但 SDK 1.0.57 下 1.1.81 与 1.1.86 都 `exit 42`。建议收窄到 `<=1.1.80`；本轮没有改，因为这是产品对外声明的支持范围。

> 第一到第三轮的状态表与审查方核验记录见 [HISTORY.md](HISTORY.md)。

## 第五轮（复测第四轮失败的三项）

见 [R5.md](R5.md)。审查方修复在 `39e5f35e`。

| 包 | 条目 | 状态 | 报告 |
|---|---|---|---|
| E1 | 三种时机的停止，之后能再发 | 未通过、按必须停下条件停止本包 | [reports/E1.md](reports/E1.md)：启动窗口 3 次，Hook 窗口两次有效中断；一次 `managed recorder open identity is not available yet`，未达到三种时机各 3 次。native hook 帧 55 个非空 ID、0 空串、0 缺失。 |
| E2 | `/plugins reload` 后能再发 | 未开始 | |
| E3 | 两个会话并发的采证 | 未开始 | |
| E4 | 第四轮其余项与未验证项 | 未开始 | |
| E5 | 全部通过才改清单；干净依赖门禁 | 未开始 | |

## 审查方对第四轮的核验（2026-11-12）

第四轮的四个提交身份符合 CLAUDE.md，D3 按规定未改清单。审查方结论：

- **停止与 `/plugins reload` 卡死**：属实。原因是轮次已有 hook 证据，却没有原生会话 ID，恢复逻辑按设计 fail closed。守护进程模式让这种情况变得常见。已在 `39e5f35e` 修复，恢复判据不变。
- **两个会话并发**：审查方在容器里确认，两个守护进程彼此独立，停掉一个不影响另一个。第四轮的现象原因未明，交 E3 采证。
- **延迟**：第四轮测得中位数 16.1 秒，当时机器负载 30 到 60，main 的对照没有跑成，不能据此下结论。

## 第四轮（Qoder 守护进程迁移的真机验证）

审查方已把 Qoder SDK 升到 1.0.59，每次运行使用专属守护进程（提交 `e50d776c`）。分支历史已改写，执行方开工前必须重置本地分支，见 [R4.md](R4.md)。

| 包 | 条目 | 状态 | 报告 |
|---|---|---|---|
| D1 | CLI 1.1.86 已登录的真实轮次，含停止、并发、managed recorder | 未开始 | |
| D2 | 发送延迟与 Qoder 日志增长 | 未开始 | |
| D3 | 通过后把兼容性清单改为 supported | 未开始 | |
| D4 | 干净依赖上的门禁，含 `pack:artifact` | 未开始 | |
