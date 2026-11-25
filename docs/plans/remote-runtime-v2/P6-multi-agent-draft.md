# P6 · 多 Agent 编排（草案）

> **暂停（维护者 2026-11-23）**：先完成 [V2 对齐](V2-alignment.md)（任务单 W20），再按其 §E 更新依赖后恢复。

状态：**草案，未批准**，不含实现。维护者 2026-11-18 决定先在 P4 设计里预留钩子（[P4-orchestration-core](P4-orchestration-core.md) §2.10），再仿 t3code 的编排 MCP 写本草案；2026-11-19 独立评审之后，维护者裁定了一批问题（[decisions](P6-multi-agent-decisions.md) §9.1），状态仍是草案。行号以分支 `claude/scry-performance-optimization-46ngcf` 的 `53117a8f` 为准；它与首稿所据的 `306e194d` 之间 `src/` 没有改动。

V2 对齐（W20）完成后，恢复本草案前需要补进设计的规则：

- 提问只唤醒父会话一次：同级多个子任务同时提问时，父会话只收到一次唤醒，其余并进同一批。
- 同级子任务的结果批量送达：同一父会话下同级子任务的结果合并成一批，不逐个唤醒。
- `DispatchModeLimit`：派发模式要有并发与频次上限，超限退回排队，不静默丢弃。

参考 `pingdotgg/t3code` `8cf97b5f`：`docs/orchestration-v2/` 的 `orchestrator-mcp-server.md`、`thread-lineage-and-context-transfer.md`、`feature-lifecycles.md`、`entity-ids-and-correlation.md`、`provider-capability-system.md`、`provider-switching-and-context.md`；`docs/user/` 的 `thread-sidebar.md`、`permission-modes.md`、`portable-handoffs.md`、`remote-access.md`、`providers-pi.md`；契约 `packages/contracts/src/orchestratorMcp.ts`。只读，不拷代码。

## 评审后修订（2026-11-19）

评审提出阻塞项 B1–B6、安全 S1–S9、生命周期 L1–L7、证据 E1–E3、事实 F1–F6 与 t3 对照的遗漏。每条先对照代码核对再写入；评审与首稿说错或需要限定的，见 decisions §10。

- **只在同一 Provider 内委派**（B1）：同名档位在不同 Provider 里效果不同。跨 Provider 以后再做，前提是逐 (Provider, 档位) 的效果表（security §S1）。
- **Agent 发起的 run 要求仓库配置与用户最近一次亲自运行时相同**（B2，security §S3）。用户 run 的自动授权不变。
- **凭据不进 argv 与环境变量**（B3、F1）：Claude、Qoder 用 SDK 进程内 MCP；Codex 用 `thread/start` 的线程级请求头。做不到的 Provider unavailable（§3.2、security §S4）。
- **委派由 Scry 自己确认**（B4，取代首稿 D11）：写工具每次都要用户在 Scry 里确认；只读工具由 adapter 自动放行，维护者按 AGENTS §3 明确同意（decisions §9.2）。
- **停止与等待**（B5、B6）：请求了停止的 run 不能再委派；会话级「停止全部子任务」；等待按版本边沿触发；读工具限速（tools §5.1、§6.3）。
- **生命周期、证据与事实更正**：L1–L7 见 tools §5–§6；E1–E3 与 S7 见 [evidence](P6-multi-agent-evidence.md)；F1–F6 见 decisions §10.2。
- **工期**：第一切片 9–11 周，在 P4（及 S3）之后（plan §W）。
- **P4 预留**同步调整：R2、R4、R5、R7、R11 改写，R6 删除，新增 R12（P4 core §2.10）。
- P4–P6 不改 scry 命令行、其命令与记录格式（D27）。

| 文件 | 内容 |
|---|---|
| 本文 | 修订说明；§0 结论；§1 目标与非目标；§2 场景；§3 机制与 Provider 注入；§4 t3code 对照 |
| [P6-multi-agent-tools](P6-multi-agent-tools.md) | §5 工具面；§6 生命周期与任务 projection；§7 上下文；§8 界面 |
| [P6-multi-agent-security](P6-multi-agent-security.md) | §S 权限上限、开关、trust、凭据、上限、Scry 确认、远程、注入、审计 |
| [P6-multi-agent-evidence](P6-multi-agent-evidence.md) | §E 结局与摘要、首轮统计、用量、并行写的归属 |
| [P6-multi-agent-plan](P6-multi-agent-plan.md) | §P 性能；§D 依赖；§W 阶段与工期；§T 测试 |
| [P6-multi-agent-decisions](P6-multi-agent-decisions.md) | §9 已决定、维护者同意、仍待决定；§10 评审核对 |

## 0. 结论

1. P4 只是 t3code Orchestration V2 核心（命令、事件、projection、outbox）的对应物。委派、等待、取消、跨会话消息、定时任务、权限上限、会话凭据是其上的另一层，本文称 P6。P4 已为它预留钩子，P6 不再改核心。
2. 机制：daemon 为每个启用委派的父 run 提供 Scry 自有的编排 MCP 服务 `scry_orchestrator`，Agent 调工具，工具变成 P4 命令。先例是历史检索 `scry_history`（`conversation-history-reader.ts:150-243`），已注入 Claude、Codex、Pi（`claude.ts:413-415`、`codex.ts:171-174`、`pi-run.ts:55-64`）；但它的凭据通道不能照搬（§3.2）。
3. 第一切片：本机发起、本机 App 在场的父 run；子任务与父 run **同一 Provider、同一 profile、同一工作区**；五个工具；每个写工具都经 Scry 确认；Codex 与 Qoder 真机；Claude 只有代码路径（真机 not-run）；深度 1；不自动唤醒父会话。约 9–11 周，在 P4（及 S3）之后。
4. 难点在 Provider 的凭据通道：Claude、Qoder 的进程内 MCP（Qoder 待 P6-0 实测）；Codex 的线程级请求头（待核对 `--strict-config`）；OpenCode unavailable；Pi 只有环境变量通道，第二切片视 P6-0。
5. 安全：同一 Provider 内只降不升；写操作由用户在 Scry 里确认；每个子 run 照常过工作区授权与 trust gate，且仓库配置须等于用户最近一次亲自运行的基线（fail closed）；actor 记为 Agent，从不显示为用户批准；Agent 不能回答审批与提问；凭据不进 argv 与环境、随 run 撤销；深度、扇出、并发、速率有上限（[security](P6-multi-agent-security.md)）。

## 1. 目标与非目标

**目标**

- 父 Agent 把子任务委派给 Scry 自有的子会话并取回结果；子会话与父 run 同一 Provider，可并行。
- 创建、确认、派发、结果、取消都是 P4 命令与事件；重启后每个子任务有可证明的结局。
- 用户在父会话里确认委派、看到子任务、回答子任务的审批、一次停止全部子任务。
- 谁发起可审计：用户（哪个 grant）还是 Agent（哪个会话、哪个 run、经哪份凭据）。

**非目标**

- 不替换 Provider 原生子 Agent（Claude 的 Task、Codex 的协作、Qoder 与 Pi 的子 Agent），它们照旧按轨迹观测（`recorder-lifecycle-events.ts:235`）。
- 不是安全沙箱。子 run 与父 run 一样以本机用户权限运行（AGENTS 开头）。
- Agent 不能配对设备、建立连接、改设置（含两个开关）、回答审批或确认。
- 不改 scry 命令行、其命令与记录格式；Recorder Core 不动（D27、D17）。
- 第一切片不跨 Provider，不把父会话历史交给子任务。

## 2. 场景

| 场景 | t3code | 本文 | 切片 |
|---|---|---|---|
| 委派一个子任务并取回结果 | `delegate_task`、`task_status` | `scry_task_delegate`、`scry_task_status`，每次委派经 Scry 确认 | 第一 |
| 并行扇出 | 多次委派；`create_threads` 一次 1–20 个 | 多次委派，受扇出上限；不做批量创建 | 第一 |
| 同一 Provider 换模型或推理强度 | 目标可换 | `target.model`、`target.effort` | 第一 |
| 跨 Provider | `target.providerInstanceId` | 前提是效果表（security §S1.4） | 以后 |
| 工作树隔离 | `isolation: 'worktree'` | 复用 `createWorkspaceWorktree`（`workspace-git.ts:77-83`） | 第二 |
| 另一台已配对执行机 | 已链接环境 + `target.environmentId` | 经执行目标转发（`execution-targets.ts`），需新能力 | 以后 |
| Agent 给别的会话发消息、等待、打断 | `t3_thread_send` / `wait` / `interrupt` | `scry_session_*` | 以后（第三） |
| 定时任务 | `schedule_task` | 不做；另立设计，依赖 P5 | 以后 |
| 子任务的审批、提问 | 审批在父会话界面；提问通知父 Agent | 都只给用户，在父会话出现 | 第一 |
| 完成后唤醒父会话 | 默认唤醒 | 不做（D5） | 以后 |

## 3. 机制

### 3.1 选择

| 方案 | 说明 | 结论 |
|---|---|---|
| A. Scry 自有编排 MCP，每 run 注入 | 同 t3；每次调用是 P4 命令，可限权、可审计 | **采用**（D1） |
| B. 借用 Provider 原生子 Agent | Scry 只能观测，不能派发、限权、确认 | 不采用 |
| C. Agent 调 Scry 命令行 | 凭据要落盘或进环境；P5 运行标记本就拦 Agent 调宿主命令行（[P5-host-security](P5-host-security.md) §4.2）；也不改命令行（D27） | 不采用 |
| D. 用户手动拆分 | 已有侧聊与原生分叉 | 不是本文目标 |

### 3.2 服务、凭据与失败

- **位置**：daemon 进程内（R11）。命令经 Orchestrator（P4 core §2.9）。
- **Claude、Qoder**：SDK 进程内 MCP（`createSdkMcpServer`，`type: 'sdk'`），绑定在该 run 的 query 上，无端口、无 token。不能用 http 型加请求头：两个 SDK 把非 sdk 型 `mcpServers` 连同请求头写进 CLI 的 `--mcp-config` 参数（F1）。Qoder SDK 1.0.17 静态上支持（decisions §10.1 第 4 条），P6-0 实测。
- **Codex**：daemon 内**一个** loopback 端点，所有 Codex 父 run 共用，凭据按 run（评审 S9）：`Host` 精确匹配、拒绝带 `Origin` 的请求、bearer、`timingSafeEqual`（同 `conversation-history-reader.ts:181-183`）、请求体 32 KiB、连接数上限。凭据经 `thread/start` 的线程级配置请求头传入，走 app-server 的 stdin JSON-RPC，不进 `-c` 参数与环境变量。P6-0 核对 Scry 的 app-server 在 `--strict-config`（`codex.ts:751-758`）下是否接受线程级 MCP 配置与请求头；不接受则 Codex unavailable，不退回历史检索的 `bearer_token_env_var`（`codex.ts:171-174`、`:782`）。
- **名称**：与仓库 MCP 重名时拒绝投递，同 `claude.ts:393`。
- **能力位**：adapter 声明 `orchestrationTools?: true`，同 `historyReader?: true`（`types.ts:246-247`）；未声明而请求委派时 registry 在启动前拒绝，同 `registry.ts:90`。
- **连接失败（D25，评审 S8）**：编排服务不可用时，`scry_capabilities` 与界面显示 unavailable 及原因，父 run 照常继续。历史检索相反，它 fail closed（`codex.ts:1631-1633`、`agent-runner.ts:467-469`），因为它是输入的一部分；编排工具只是附加能力，不改变用户这一轮的输入。
- **审批**：security §S6。

### 3.3 各 Provider 的注入可行性

| Provider | 凭据通道 | client 复用 | 档位 | 第一切片 |
|---|---|---|---|---|
| Claude | SDK 进程内 MCP | 每个 query 一份，无损失 | 四档（`claude.ts:292`） | 代码路径与单测；真机 **not-run**（未授权真实运行） |
| Codex | `thread/start` 线程级请求头 → 共用端点 | 凭据不再进 client 键（今天历史检索的键含它，`codex.ts:736-737`，每 run 专用 client、run 后关闭，`:1719`），父 run 可复用池化 client；子 run 不带工具，本就用池化 client，`forceKill` 是共享 transport（`:1771-1774`，F5） | `default`、`auto_review`、`full_access`（`:1983`） | 是，视 P6-0 |
| Qoder | SDK 进程内 MCP（`strictMcpConfig`、`mcpServers`，`qoder-launch.ts:173-174`） | 每个 query 一份 | 四档（`qoder-catalog.ts:224`） | 是，视 P6-0 |
| OpenCode | MCP 写进按 cwd 池化的 server 配置（`opencode-server.ts:486-500`、`:883`；`opencode-server-pool.ts:112-118`），凭据会落盘或进环境 | — | `default`、`full_access`（`opencode-controls.ts:44`） | **unavailable** |
| Pi | 今天历史检索走环境变量（`pi-run.ts:62-64`），不进池（`:66-67`）。环境变量通道被 D16 排除 | 每进程一份 | 只有 `full_access`（`pi-catalog.ts:317-321`） | 第二切片，前提是 P6-0 找到别的通道 |

**Codex 的 code mode（L7）**：t3 记录 code mode 约 30 s 让出脚本，所以把等待与委派登记为直接调用（`omit_tools_from = ["code_mode", "deferred"]`）。Scry 的 app-server 参数没有涉及 code mode（`codex.ts:751-758`），默认是否开启由 P6-0 核对；开启则同样登记。等待上限 20 s，该服务的 `tool_timeout_sec` 设 30（历史检索是 10，`codex.ts:174`）。

## 4. t3code 对照

| 概念 | t3code | 本文 |
|---|---|---|
| 入口 | 一个共享 HTTP 端点 `/mcp`，凭据按 Provider 会话 | Claude、Qoder 进程内；Codex 一个共享端点，凭据按 run |
| 凭据传给 Codex | `thread/start` 的线程级请求头 | 同；做不到即 unavailable |
| 凭据寿命 | 最长寿命、空闲过期、会话释放即撤销 | 随 run 撤销，不设空闲过期 |
| 工具审批 | 自动放行 | **不同**：读工具由 adapter 放行；写工具每次 Scry 确认 |
| 权限上限 | 子任务只等或更窄 | 同，且只在同一 Provider 内比较 |
| 目标不提供的模式 | 退到目标提供的最宽模式 | 不适用（同 Provider）；不隐式降档 |
| 机器级托管策略 | 管理员可设档位上限 | 不做；以后另议（decisions §9.3） |
| 等待工具 | 在 code mode 下直接登记 | 同（§3.3） |
| 首轮编排说明 | 写进首轮指令 | **不同**：只在工具描述里，轮次正文保持用户所写（tools §7） |
| 子任务上下文 | 只有任务提示与可选角色 | 同 |
| 子任务提问 | 通知父 Agent，可代答 | **不同**：只给用户 |
| 子任务审批 | 父会话界面 | 同 |
| 完成后 | 唤醒父线程 | 第一切片不唤醒 |
| Stop | 深度优先停止全部委派任务，effect 发出 | 同；决策器同一事务；另有会话级「停止全部子任务」 |
| 取消已终态任务 | 返回现状 | 同 |
| `workState` | 线程级工作状态 | 由任务 `status` 与 projection 推导，不另设（tools §6.5） |
| 幂等 | `clientRequestId` 按 Provider 会话 | 委派必填，按调用方 run（tools §5.1） |
| 谱系 | `parentThreadId`、`relationshipToParent`、`ContextTransfer` | `lineage`（R1），沿用原生分叉与侧聊名称 |
| 来源 | `createdBy` 与 `creationSource` 分开 | `actor` 与 `author` 分开（R2、R3） |
| 跨机 | 已链接环境，上限取较窄者 | 以后；配对只由用户完成 |
| 定时任务 | 间隔、定时、webhook | 不做 |

t3 一列据首稿与评审转述，`omit_tools_from`、凭据头、首轮说明、托管策略、`workState` 五项本次未重新核对 t3 源码。
