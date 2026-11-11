# 第四轮进行中（D1 未通过，见 reports/D1.md）

> **维护者决定（2026-11-11）：本机不使用 Claude CLI，所有依赖 Claude 真实运行的条目不再推进。** 受影响：B（Q1 到 Q11、真实夹具）、C 的运行中 / 失败 / 停止截图、E2、E3 的“按名称运行”、G4 的“带真实 workflow 行的会话”。它们保持未验证，不是阻塞待解除。执行方不要再为它们探测网关、找凭据或想办法启动 Claude。

**第四轮（D1–D4，Qoder 守护进程迁移的真机验证，见 [R4.md](R4.md)）进行中。D1 未通过，因此 D3 不改兼容性清单。**

- **D1（未通过）**：[reports/D1.md](reports/D1.md)。本机 CLI 1.1.86 + SDK 1.0.59 在独立 test 实例上跑真实轮次。通过：普通一轮（3 个工具、文件足迹、用量、diff、`.scry` 记录 0.2.63）、审批允许、managed recorder 的 `managedRunId` 与界面 run ID 一致、MCP 读取（空态、无残留守护进程）、App 退出无长期残留。
  失败：**停止（或在 Provider 给出 session id 前取消/`/plugins reload`）之后，同一工作区的后续轮次被 `Scry trace 仍有 1 轮待恢复` 永久拦住**，重启也不能恢复（`d1n`），因为 pending 记录是 `missing_provider_session_id` 且带着 22 条 hook 证据，`trace-turn-progress.ts` 的 `isProviderlessTerminalTurn` 永远判为可恢复却无法恢复；`/plugins reload` 在 Provider 侧成功（5 个插件、84 条命令）但 recorder 报 `requires an authoritative Provider session id`；两个会话不能真正同时跑，切到新会话会丢掉前一轮的证据。停止本身会先等 4 秒再强制结束，守护进程在 8–13 秒内退出。
  未验证：审批拒绝、分支、后台子 Agent（`Task×2` 启动后 `Operation aborted`）、MCP OAuth。
- **D2 / D4**：见下方各包报告。


**这对 Workflow 面板意味着什么**：面板的阶段与 agent 明细来自 Claude Code 未公开的 `workflow_progress` 字段，字段形状是从 CLI 2.1.251 与 2.1.322 的程序包里读出的，从未在真实运行上核对。已有的保护是：字段缺失时面板显示 unavailable，没有终态时显示状态未知，识别只看结构化字段。若真实格式不同，最坏情况是 Claude 会话里面板显示 unavailable 或明细不全，不会误判其他 Provider（第二、三轮已用真实 Codex、Pi、OpenCode、Qoder 运行确认）。


第三轮（Q1–Q4，验证 Qoder SDK 1.0.17 → 1.0.57 的真机效果并补跑 Qoder 与 rotom）已在 macOS 本机完成并 push，做法见 [R3.md](R3.md)。四个包的报告：[Q1](reports/Q1.md)、[Q2](reports/Q2.md)、[Q3](reports/Q3.md)、[Q4](reports/Q4.md)。

- **Q1**：只升 SDK 不够。本机 CLI 1.1.86 与 1.1.81 都报 `sdk_worker_removed`、`exit 42`；换 CLI 1.1.80 后 Qoder 在真实 App 里跑通（29.8k in / 3 out / 6.3s，`workflow_activity` 0）。这与 R3 表格里「1.0.57 配套 CLI 1.1.81」不一致，CLI 自己给出的上界是 1.1.80 或更早。
- **Q2**：升级后的日常路径逐项通过——读写文件与 Bash、审批允许与拒绝、停止（无残留进程、显示「本轮已中断」）、重启后恢复、分支会话、`TaskCreate/TaskUpdate/UpdateGoal`、MCP。两处如实说明：Provider 对失败的子 Agent 也报 `completed`；登录失效提示未验证。
- **Q3**：Qoder 8 轮真实运行的 `workflow_activity` 全为 0；真实脱敏事件做成夹具 `src/main/workflow-wire-fixtures/qoder-background-agent.ts` 并带回放测试（负对照放宽判据后 3 条失败）。rotom `0.1.27-main.655c35f2` 跑出 `kind: subagent` 与 `kind: workflow` 两种异步运行，后台卡片都显示、Workflow 面板空态。
- **Q4**：干净 `npm ci` 后五道门禁全部 EXIT=0，`pack:artifact` 的产物含 Qoder SDK 与 `cross-spawn`，证实上一轮那次失败是共享 `node_modules` 所致。

**待维护者决定的一条**：兼容性清单仍把 Qoder CLI `>=1.1.60 <1.2.0` 标为受支持，但 SDK 1.0.57 下 1.1.81 与 1.1.86 都 `exit 42`。建议收窄到 `<=1.1.80`；本轮没有改，因为这是产品对外声明的支持范围。

## 第二轮已核验（审查方 2026-11-11）

第二轮（G1–G5，不用 Claude，改用 OpenCode / Codex / Qoder / Pi `rotom`）已在本机完成并 push，总结见 [reports/SUMMARY-R2.md](reports/SUMMARY-R2.md)。G1 的四个 Provider 里 Codex、Pi 原生、OpenCode 有真实运行证据，Qoder 与 Pi `rotom` 标为阻塞；G2、G3、G5 完成；G4 部分完成（缺一个带真实 workflow 行的会话）。第一轮的「全部待核验」结论保留在下方。

## 第一轮

执行方已在 macOS 本机完成本轮能做的部分并 push。**B 被外部 Provider 阻塞**（公司网关持续 429），因此 C 的运行态截图、E2 文案核对、Q1–Q11 未完成。下面的「待核验」表示执行方已做完并 push，等审查方核验；「阻塞」「部分完成」「未开始」都是未完成项，不要当成通过。总结见 [reports/SUMMARY.md](reports/SUMMARY.md)。

| 包 | 条目 | 状态 | 报告 | 备注 |
|---|---|---|---|---|
| A | macOS 环境与基线 | 已核验 | [reports/A.md](reports/A.md) | 全部命令退出码 0；`ef8d455d`。本机终端安全软件会拦截直接拉起的 claude；**不得用 shim 绕过**，见下方审查结论 |
| B | 真实事件核对，Q1 到 Q11 | 不做（维护者本机无法运行 Claude CLI） | | 公司网关对 `claude-sonnet-4-6`/`claude-opus-4-6` 持续 429“模型提供方限流”（证据见 reports/B.md），其他模型名 400/404；等待网关恢复后立即开跑 |
| B | 真实夹具与回放测试 | 未开始 | | |
| C | 真实 App 验收与截图 | 部分完成 | [reports/C.md](reports/C.md) | 真实 App 已覆盖：完成态、真实退出再启动、窄宽/窄窗口/宽窗口、Agents 标签页、切到无 Workflow 行的会话再切回；运行中/失败/停止等真实运行态被 B 阻塞 |
| D | 归档回放冒烟与负对照 | 已核验 | [reports/D.md](reports/D.md) | `npm run test:workflow-archive` 正向通过，启动两次（含真实退出重启）；负对照（去掉 workflow 去重键）失败；回放发现并修掉“活动行先到 → 两个运行”“已观测到调用却说没有”两个缺陷 |
| E1 | 从聊天区打开面板 | 已核验（审查方补修一处） | [reports/E.md](reports/E.md) | 卡片入口 + focus store 选中本次运行；`ChatView` 漏传回调已补，负对照失败过 |
| E2 | 文案以实测为准 | 不做（依赖 Claude 真实运行） | | 依赖 Q8 与 B 的实测事件；空态与“来自某事件”的措辞已按现有代码可证的部分核对过 |
| E3 | 脚本不可得时的说明 | 部分完成 | [reports/E.md](reports/E.md) | 脚本不可得两种说明有测试；阶段无独立声明时不再把合成 `phase N` 说成已声明，改成正文可见提示；真实“按名称运行”待 B |
| E4 | 大规模运行的上限与耗时 | 已核验 | [reports/E.md](reports/E.md) | 1,000/3,000 agent 夹具；128 行/事件、2,048 行、48 chip、300 日志均有断言；归一化 9ms、40 次重折叠 24–42ms，无需增量折叠 |
| E5 | 用量不重复计算 | 已核验（真实语义待 B） | [reports/E.md](reports/E.md) | 总量/分析/落盘只认 `harness/result`；面板任务级用量单独展示，测试用 26,600 vs 1,200 证明不双计 |
| F | macOS 全量门禁与总结 | 部分完成 | [reports/F.md](reports/F.md) | `test:renderer:ui` 通过；`pack:artifact`（打包+产物校验+Electron 冒烟）通过；`pack` 整体因本机 5,000ms 超时用例为 1，已用 `origin/main` 对照证明与本次改动无关；未安装到 /Applications |

## 第二轮（不用 Claude）

维护者决定先用 OpenCode、Codex、Qoder、Pi `rotom` 验证。做法见 [R2.md](R2.md)。这一轮不能回答 Q1 到 Q11，B 仍阻塞。

| 包 | 条目 | 状态 | 报告 |
|---|---|---|---|
| G1 | 四个 Provider 的真实事件负对照，含与 main 的对照 | 完成（两处阻塞） | [G1](reports/G1.md) · [Qoder 部分](reports/G1-qoder.md) · [OpenCode 部分](reports/G1-opencode.md) | Codex 真实两个子 Agent，与 `origin/main` 逐项一致、`workflow_activity` 0；Pi 原生空态正确；OpenCode 换到支持范围内 1.18.31 后跑通真实一轮、空态正确。**阻塞**：Qoder 在分支与 main 上同样 exit 42（仓库外同 SDK 复现），本机 2.2.6 的 OpenCode 405，Pi rotom 安装缺 `model-catalog.mjs` |
| G2 | 运行选择被拉回的组件级回归与负对照 | 完成 | [G2](reports/G2.md) | `test:workflow-ui` 新增 `focus` 模式，两个宽度通过；删掉清空请求那一行后真的失败 |
| G3 | 在最新 HEAD 上重跑门禁 | 完成（两处环境失败） | [G3](reports/G3.md) | `typecheck`/`build`/`test:workflow-ui`/`test:workflow-archive`/`test:renderer:ui` 在 `1e41d87c` 上 EXIT=0；`pack:artifact` 失败但 `origin/main` 同样失败（共享 `node_modules` 被别的进程改动）；`test:unit --maxWorkers=1` 7 个失败全是压力下 spawn 超时，两个文件单独跑都通过 | |
| G4 | C7 与相邻路径收尾 | 部分完成 | [G4](reports/G4.md) | 一个实例里 Codex（2 子 Agent）与 OpenCode（0 工具）来回切，Workflow 标签一直开着：切到 B 空态无残留，Agents 按会话分开，切回 A 两个子 Agent 恢复。带真实 workflow 行的会话无法在同一实例里造出来（Claude 阻塞），运行态残留未验证 | |
| G5 | 其他 Provider 接入的设计说明（不实现） | 完成（仅设计） | [G5](reports/G5.md) | Pi `kind: workflow` 能撑「运行 + 步骤 + 终态」，撑不起「阶段 + 每 agent 用量」；Qoder 缺真实事件不能开工；列出三条不许做的事与成本估计，未改代码 | |

## 第四轮（Qoder 守护进程迁移的真机验证）

审查方已把 Qoder SDK 升到 1.0.59，每次运行使用专属守护进程（提交 `e50d776c`）。分支历史已改写，执行方开工前必须重置本地分支，见 [R4.md](R4.md)。

| 包 | 条目 | 状态 | 报告 |
|---|---|---|---|
| D1 | CLI 1.1.86 已登录的真实轮次，含停止、并发、managed recorder | 未开始 | |
| D2 | 发送延迟与 Qoder 日志增长 | 未开始 | |
| D3 | 通过后把兼容性清单改为 supported | 未开始 | |
| D4 | 干净依赖上的门禁，含 `pack:artifact` | 未开始 | |

## 第三轮（Qoder SDK 升级的真机验证）

审查方已把 `@qoder-ai/qoder-agent-sdk` 从 1.0.17 升到 1.0.57（最后一个“每轮一个子进程”的版本），理由与边界见 [R3.md](R3.md)。容器里没有真实 Qoder 运行。

| 包 | 条目 | 状态 | 报告 |
|---|---|---|---|
| Q1 | Qoder 能否跑起来，失败则抓 stderr 并试 CLI 1.1.81 | 完成 | [Q1](reports/Q1.md) | 只升 SDK 不够：CLI 1.1.86 与 1.1.81 都报 `sdk_worker_removed`、`exit 42`；换 CLI 1.1.80 后真实一轮跑通（29.8k in / 3 out / 6.3s），`workflow_activity` 0 |
| Q2 | 升级后的 Qoder 日常路径回归 | 完成（认证失效未验证） | [Q2](reports/Q2.md) | 读写文件与 Bash、审批允许与拒绝、停止（无残留进程）、重启后恢复、分支会话、后台子 Agent、`TaskCreate/TaskUpdate/UpdateGoal`、MCP 全部有真实证据。两处如实说明：Provider 对失败子 Agent 也报 `completed`；登录失效提示未验证 |
| Q3 | 补跑 G1 的 Qoder 与 rotom，加真实 Qoder 夹具 | 完成 | [Q3](reports/Q3.md) | Qoder 8 轮真实运行 `workflow_activity` 全为 0，Agents 面板与后台卡片正确；真实脱敏事件做成夹具 `src/main/workflow-wire-fixtures/qoder-background-agent.ts` 并加回放测试（4 条，负对照放宽判据后 3 条失败）。rotom `0.1.27-main.655c35f2` 跑出 `kind: subagent` 与 `kind: workflow` 两种异步运行，后台卡片都显示、Workflow 面板空态、`workflow_activity` 0 |
| Q4 | 干净依赖上的门禁，含 `pack:artifact` | 完成（一条证据问题待定） | [Q4](reports/Q4.md) | 干净 `npm ci` 后在 `45b15893` 上 `build`/`typecheck`/`test:workflow-ui`/`test:workflow-archive`/`test:renderer:ui`/`pack:artifact` 全部 EXIT=0；产物含 Qoder SDK 与 `cross-spawn`，证实 G3 的 `pack:artifact` 失败是共享 `node_modules` 所致。**未改代码的证据问题**：兼容性清单把 Qoder CLI `1.1.81–1.1.86` 也算「受支持」，但 SDK 1.0.57 下它们都 `exit 42`，建议收窄到 `<=1.1.80`，需维护者确认 |

## 审查方对第三轮的核验（2026-11-11，Linux x64 容器）

核验对象：`eeda801f..08490a23`（5 个提交，身份符合 CLAUDE.md）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 0 个错误 |
| 真实 Qoder 回放测试与 Qoder 适配器测试 | 10 个文件 185 项通过 |
| 回放负对照：任何 `task_type` 都算 workflow | 3 项失败，恢复后通过 |
| 真实夹具与报告中的个人路径、账号、令牌 | 未发现 |

审查方修正：

- **回放没走 Qoder 的生产入口。** 原测试直接调 `normalizeSdkMessage`，而 Qoder 在生产中先经过 `normalizeQoderMessage`，后者把 `task_updated` 改写成终态。改走生产入口后，每个后台 Agent 在启动回执之后有两条终态结果（`qoder_task_updated` 与 `provider_task_notification`），都是 `completed`。这段改写在 main 上就是如此，不是本分支引入的。测试已按生产路径如实断言。
- **一条恒真断言。** `event.stage === 'harness'` 永远不成立，改为 `event.kind === 'harness'`。

结论：Q1 到 Q4 已核验。Q1 的关键事实是 CLI 1.1.81 起拒绝“每轮一个子进程”的 SDK 会话（`sdk_worker_removed`），所以 SDK 1.0.57 只能配 CLI 1.1.80 及更早；R3 写的“配套 1.1.81”是按 SDK 包里的字段推的，以 CLI 报错为准。兼容性清单是否收窄、是否迁移到守护进程模式，等维护者决定。

## 审查方对第二轮的核验（2026-11-11，Linux x64 容器，Xvfb，非 root，Chromium 沙箱开启）

核验对象：`0425137a..e77c8ee8`（6 个提交，身份符合 CLAUDE.md）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 0 个错误 |
| 本轮新增的两条用例与 focus store 测试 | 26 项通过 |
| 既有 Qoder 适配器测试 5 个文件 | 148 项通过 |
| `scripts/workflow-surface-ui-smoke.mjs`，含新的 focus 模式 | 通过 |
| focus 模式负对照：保留未消费的请求 | 失败，报“流式更新把选择拉回”，恢复后通过 |
| 报告与证据中的内部地址、账号、个人路径 | 未发现 |

审查方更正：

- **G1 结论过度**：Codex、Pi、OpenCode 不经过本分支改动的归一化代码，只有 Claude 和 Qoder 经过。共享入口的回归只有合成证据，真实 Qoder 事件仍缺。已在 G1 与 SUMMARY-R2 加注。
- **G5 能力矩阵**：后台任务卡片只有 Qoder 和 Pi，原表写成五个 Provider 都有。已改。
- **证据目录**：两轮的截图和事件统计都提交到了仓库根目录 `evidence/`。已移到本交接目录下，报告里的相对路径因此变为正确。

结论：G2、G3 已核验。G1 对 Codex、Pi 原生、OpenCode 1.18.31 的空态结论成立，对共享入口的结论按上面更正。G4 部分完成，G5 设计说明可用。Qoder、Pi `rotom`、OpenCode 2.2.6 的阻塞都有归因，不是本分支引入的。

## 审查方核验结论（2026-11-10，Linux x64 容器，Xvfb，非 root，Chromium 沙箱开启）

核验对象：执行方推送的 `c8e47425..aad84eff`（13 个提交，身份均符合 CLAUDE.md）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 0 个错误 |
| 执行方新增与相邻的 17 个测试文件 | 458 项全部通过 |
| `scripts/workflow-archive-smoke.mjs`（真实 App，含真实退出再启动） | 通过，两次启动的阶段、agent、终态一致 |
| 上项负对照：去掉 workflow 去重键 | 失败（面板无阶段），恢复后再通过，与 D 报告一致 |
| 本次改动的文件大小 | 均不超过 20,000 字节 |

审查方补修：

- **E1 选择被拉回**：从聊天卡片打开面板后，请求一直留在共享 store 里。面板在每次流式更新时重跑选择逻辑，用户在运行选择器里手动换一次，下一次更新就被拉回卡片对应的运行。改为请求生效一次即清空，未加载的运行仍保持等待。测试在 `src/renderer/workflow-focus.test.ts`。这两个用例测的是 store 的消费语义，组件层没有 DOM 测试工具，未做组件级回归。
- **公开仓库里的内部信息**：仓库是公开的。B 报告写了公司内部网关地址和错误码，A 报告写了终端安全软件的产品名。已从分支头移除，历史提交 `c8e47425`、`a9ace643` 里仍有，是否改写已推送历史需要维护者决定。另：`main` 上原有的两份发布记录也写了公司内部 npm registry 地址，不属于本分支，另列待办。

不采用的做法：

- **用 shim 绕过终端安全软件**（A 报告）。这是绕过公司安全控制。B 恢复前须先向公司 IT / 安全确认 Claude CLI 是否获准在这台机器上运行，并使用获准的启动方式。
- **每 90 秒轮询公司网关数小时**。网关明确返回资源紧张，持续轮询只会加重共享资源压力。等维护者确认通道可用后再跑，不做自动轮询。

仍未验证：Q1 到 Q11 全部、真实运行中 / 失败 / 停止截图、按名称运行、真实用量语义、停止按钮对 workflow 的效果、其他 Provider 空态、macOS 上 `npm run pack` 的整体退出码。

## 已由审查方完成（Linux 容器）

| 条目 | 结果 |
|---|---|
| 数据层、投影、面板、冒烟脚本 | 提交 `09304e7b` |
| 历史恢复去重修复与回归测试 | 提交 `09304e7b`，拆分在 `3a015367` |
| 真实 workflow 运行 | 未做，交给包 B |
| macOS、打包产物 | 未做，交给包 A、F |
