# 第九轮进行中（I1 通过，I2–I5 待执行）

[I1](reports/I1.md)：CLI 1.1.89，三个全新独立实例的 Hook 窗口停止均无需重启即显示中断、提交唯一带 Provider turn id 的 interrupted 记录，来源 scry_run_boundary；pending 全空，续发均 completed。[脱敏结构](evidence/r9/i1-live-stop.json)。

**审查方核验第八轮（2026-11-16）。** 以下已在 CLI 1.1.89 上证实：H1 启动窗口停止与负对照；H2 后台 Agent 的流关闭顺序（`Operation aborted` 消失）；H4 长命令审批、reload 后续发、输出中途停止。

- H4 Hook 窗口停止要重启才提交：已改为实时提交（`71ffdb5d`）。
- H2 recorder 身份不一致、H3 分支找不到归档：报错现在附带计数（`3eb50e4d`）。审查方先前对 H2 的假设已用测试推翻，根因未定，本轮采证。
- H5 unit 超时：本机 node 启动要 0.9 秒，用例每条要启动约 6 个进程，属于环境成本。打包时的 SIGKILL 重试后通过，原因未知。

清单仍是 `unsupported`，判断正确。做法见 [R9.md](R9.md)，启动提示见 [PROMPT-R9.md](PROMPT-R9.md)。

## 第八轮报告（已核验）

### 第八轮待核验（H1 通过，H2/H3 未通过，H4 部分通过，H5 unit 未通过）

[H1](reports/H1.md) 在本机 Qoder CLI 1.1.89 的独立 test 实例里，启动窗口 114/367/712 ms 三次停止均显示中断、native 0、本 run 守护进程从未开始，下一轮完成；不点停止的负对照正常完成。每例保存主进程标准输出，脱敏结构见 [H1 证据](evidence/r8/h1-startup.json)。[H2](reports/H2.md) 两个后台 Agent 的通知均到达，`query closing` 晚于最后通知后的 result，未再出现 `Operation aborted`；但 managed recorder 仍报 Provider turn id 与 open lifecycle identity 不同，记录未提交，等待 UI 截图未取得。[脱敏时间线](evidence/r8/h2-timeline.json)。[H3](reports/H3.md) 在已完成轮次上点击分支后，报错原因是「没有找到该会话的归档」；只交原因，不修改产品。[H4](reports/H4.md) 长命令审批允许、新对话 reload 续发、输出中途停止通过；Hook 窗口停止初始无记录且 UI 报 recorder open identity 不可用，保留现场并重启后才恢复 interrupted 记录。实时收口不算通过。[脱敏回归结构](evidence/r8/h4-regressions.json)。[H5](reports/H5.md) 干净 worktree 的 typecheck、renderer UI 通过；unit 五条超时，按 R8 空载测 Node 启动耗时后只定向重跑一次，仍五条超时。`pack:artifact` 初次校验私有 CLI 收到 `SIGKILL`；按用户要求沿原路径重试，定向校验和完整打包/校验/smoke 均通过。未绕过安全策略，初次终止原因仍未知。Qoder 清单保持 `unsupported`。H1–H5 已逐包记录，**本轮不是兼容性验收通过**。

**审查方核验第七轮（2026-11-15）。** G1、G3 通过，第六轮的三处修复在真机上成立；G0 证实了 hook 拆分的推断。G2、G4 的证据定位出四个问题，均已修复：

- 发送后、runId 返回前点的停止被 renderer 丢弃（`db4f9015`）。
- 实时中断轮次不显示中断（`285099b4`）。
- 后台 Agent：在通知送达前就关闭输入流，导致 `Operation aborted`（`ebb660f4`）。
- 分支报错不说原因、守护进程无法对应到 run（`c7da591b`，诊断）。

分支的根因还没定，本轮采证。G5 的超时更像本机进程启动慢，本轮测量。清单仍是 `unsupported`，判断正确。做法见 [R8.md](R8.md)，启动提示见 [PROMPT-R8.md](PROMPT-R8.md)。

## 第七轮报告（已核验）

### 第七轮待核验

本轮使用本机 CLI **1.1.88**，G0–G5 已逐包执行、报告并推送；**不是兼容性验收通过**。

- [G0](reports/G0.md)：旧备份有 3 个 SDK started 与 3 个 CLI error response 的未配对 `SessionStart`，与审查方推断一致；[脱敏计数](evidence/r7/g0-hook-source-counts.json)。
- [G1](reports/G1.md)：长命令允许与拒绝均通过，完整命令在「允许一次」说明可见；记录完成、journal 无残留。[脱敏计数](evidence/r7/g1-summary.json)。
- [G2](reports/G2.md)：三次 1 秒内停止没有一次满足完整启动窗口标准；Hook/输出回归记录的 `SessionStart` 未拆分，输出回归续发受版本探测阻碍。[逐例结构](evidence/r7/g2-attempts.json)。
- [G3](reports/G3.md)：新会话与已有会话的 reload、续发和重启显示符合预期。[脱敏计数](evidence/r7/g3-reload.json)。
- [G4](reports/G4.md)：分支失败、双后台 Agent 的根轮次 `Operation aborted` 且 recorder 留 pending；仅采证未修，close/stop 精确时刻与 fork 入参未采得。[脱敏时间线](evidence/r7/g4-fork-agents.json)。
- [G5](reports/G5.md)：R7 前提不足，Qoder 清单保持 `unsupported`。干净依赖的 typecheck、renderer UI（原生重建后）、pack 通过；unit 初跑 4 条超时，空载单次定向重跑仍有 3 条超时。未安装或发布。

**审查方核验第六轮（2026-11-15）。** 执行方的证据足够定位三处问题，均已修复：

- 旧 E4 `invalid canonical record`：审批标题超过记录合同的 120 字符上限（`cc75676b`）。
- reload 之后下一轮找不到 transcript：审查方第四轮引入，已改为新对话里的 reload 不报告会话 ID（`fda34e0e`）。
- SessionStart 运行次数虚增：CLI 日志与 SDK 各报半次，没有合并（`0f95dddf`，原因是推断的，G0 核对）。

F2 启动窗口需要改的是验收标准，不是代码。F3 分支和后台 Agent 根轮次 `Operation aborted` 证据不足，本轮补采。F4 的 4 个超时在空载容器里 2.6 秒通过，与负载解释一致（Linux，不代替 macOS）。清单仍是 `unsupported`，判断正确。做法见 [R7.md](R7.md)，启动提示见 [PROMPT-R7.md](PROMPT-R7.md)。

## 第六轮报告（已核验）

### 第六轮待核验（F1 未通过，F2/F3 部分通过，清单未放开）

F0–F4 均已执行并逐包提交推送，等待审查方核验；**不是兼容性验收通过**。F0 旧 E4 恢复报 `$.interventions invalid intervention evidence`，hook-1 补采了 hookId 配对计数；F1 reload 本身通过但下一轮源 transcript 缺失；F2 Hook 与输出中途各三次续发成功，启动期五次点击无可验证终态；F3 普通工具与审批/重启通过，但分支未证实独立身份、两个后台 Agent 的根轮次 aborted；F4 不改 `unsupported`，干净门禁 typecheck/renderer UI/pack 通过，unit 4 条 5 秒超时退出 1。详见 [F0](reports/F0.md)、[F1](reports/F1.md)、[F2](reports/F2.md)、[F3](reports/F3.md)、[F4](reports/F4.md)。

F0 原路径恢复得到 E4 `$.interventions invalid intervention evidence`；脱敏结构见 [证据](evidence/r6/f0-e4-interventions.json)。hook-1 已提交记录的 19 个元素和备份 journal 的 hookId 配对计数见 [证据](evidence/r6/f0-hook-structure.json)。结论与限制见 [F0 报告](reports/F0.md)。本机 qodercli 1.1.88。[F1](reports/F1.md) 中 `/plugins reload` 命令卡片与无 `.scry` 记录通过，但同会话下一轮失败：daemon resume/fork 源 transcript 缺失。[F2](reports/F2.md) Hook 窗口与输出中途各有 3 次停止后续发成功；启动窗口 5 次点击都缺可证明中断的终态，未达验收。[F3](reports/F3.md) 普通工具轮次与拒绝、重启续发通过；旧 E4 的 `$.interventions` 错误在新样本未复现，分支独立身份未证实，两后台 Agent 完成但根轮次 aborted。[F4](reports/F4.md) 干净 worktree 门禁三过一失败，保持 `unsupported`。

**审查方核验 F0（2026-11-13）。** 被提交的 hook-1 带有 Provider turn id，走的是 2026-09 就有的 `reserveCanonicalJournalRecovery`，在启动回放时触发。它不是 `f87c91b9` 引入的，记录也如实。审查方用相同结构写了复现用例，分别在当前代码和第五轮代码 `6ae2e8ea` 上运行，结果一致。执行方停下是因为 R6 的措辞把“未知 hook 保持 pending”写得太宽，责任在审查方。审查方也更正了自己的先前判断：hook-1 不是 `f87c91b9` 处理的情形，那个情形在真机上还没观测到过。续跑要求和新的停下条件见 [R6.md](R6.md) 末尾一节，启动提示见 [PROMPT-R6b.md](PROMPT-R6b.md)。

## 执行方 F0 报告（已核验）

### 第六轮暂停（F0 触发必须停下条件，未到待核验）

F0 旧 E1 hook-1 现场启动恢复后，含未知 `QueryEnd` hook 的中断轮次被提交到 `.scry/records`；按 [R6.md](R6.md) 的 fail-closed 与“不得提交不该提交的轮次”条款立即停止。两处旧现场先完整备份，E4 原路径未启动。另检测到当前 CLI 为 1.1.88，非本轮目标 1.1.86。详见 [reports/F0.md](reports/F0.md) 与脱敏 [F0 结构证据](evidence/r6/f0-summary.json)。F1–F4 尚未执行；兼容性清单仍为 `unsupported`。维护者须先核对这一合同冲突和 CLI 版本入口，才可继续。

**审查方对第五轮的核验（2026-11-12）。** E3 的并发隔离成立，E4 的业务执行成功，所以守护进程本身可用。剩下的失败都在 managed recorder，维护者授权审查方修改：

- E2 `/plugins reload`：改为命令型轮次，不进 `.scry/records`（`5d2d7f6e`）。
- E1 hook-1：只跑过会话级 hook 时，按观测到的中断落盘；遇到 `UserPromptSubmit` 或工具 hook 时仍然 pending，并在报错里说明原因（`f87c91b9`）。
- E4 `invalid canonical record`：现在会报出字段路径（`a99c2fa1`），用仓库夹具没能复现，**未修**，等这一轮在真机上拿到字段。
- E3 第四轮 A 消失的原因：本轮不再追查。
- E5 未放开清单：判断正确。

`managed-turn-commit.ts` 超过 20KB，已按职责拆分，行为不变（`b25573e7`）。容器内的验证结果：main 2,900 条测试通过（另有 2 条已知失败，是 root 身份绕过目录权限所致），recorder 600 条通过，`typecheck` 与 `build:cli` 通过；负对照下，新增的 6 个用例在旧代码上全部失败。**没有在已登录的 Qoder 上验证。**

第六轮做法见 [R6.md](R6.md)，启动提示见 [PROMPT-R6.md](PROMPT-R6.md)。

---

## 第五轮报告（E1/E2 未通过，清单未放开）

第五轮 E1–E5 已逐包提交并推送，等待审查方核验。E1 停止窗口触发 recorder open identity 错误；E2 `/plugins reload` 触发 recorder canonical 时点错误；E3 旧 A 守护进程退出原因仍无当时的 stop 日志；E4 仅部分通过。因此 E5 按前提**没有**把 Qoder 标成 `supported`。门禁 typecheck、renderer UI、pack 通过，unit 有 12 条 5 秒超时（退出码 1）。详见 [E1](reports/E1.md)、[E2](reports/E2.md)、[E3](reports/E3.md)、[E4](reports/E4.md)、[E5](reports/E5.md)。

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
| E2 | `/plugins reload` 后能再发 | 未通过、按必须停下条件停止本包 | [reports/E2.md](reports/E2.md)：Provider 重载成功（6 插件、84 命令），recorder 报 `requires canonical Provider or observed interruption timing`；后续消息留在暂停队列。 |
| E3 | 两个会话并发的采证 | 部分完成，旧 A 退出原因未知 | [reports/E3.md](reports/E3.md)：新样本 A 已输出后切 B，两个 PID 独立；B 停止后 12 秒 A PID 仍存活，但切回未读到新增正文。旧样本无 native 终态或 main stop 日志，不能归因。 |
| E4 | 第四轮其余项与未验证项 | 部分通过 | [reports/E4.md](reports/E4.md)：审批拒绝及重启后续发通过；普通工具轮次成功写文件但 recorder 报 invalid canonical record；分支未证实新会话；两后台 Agent 完成但根轮次 aborted。 |
| E5 | 全部通过才改清单；干净依赖门禁 | 清单未改，门禁三过一失败 | [reports/E5.md](reports/E5.md)：干净 worktree `npm ci`；typecheck/renderer UI/pack 退出 0，unit 12 条超时退出 1。 |

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
