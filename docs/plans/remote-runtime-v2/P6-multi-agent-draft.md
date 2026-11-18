# P6 · 多 Agent 编排（草案）

状态：**草案，未批准**，不含实现。维护者 2026-11-18 决定：先在 P4 设计里预留钩子（[P4-orchestration-core](P4-orchestration-core.md) §2.10，R1–R11），再仿 t3code 的编排 MCP 写本草案。行号以分支 `claude/scry-performance-optimization-46ngcf` 的 `306e194d` 为准。

参考 `pingdotgg/t3code` `8cf97b5f`：`docs/orchestration-v2/` 的 `orchestrator-mcp-server.md`、`thread-lineage-and-context-transfer.md`、`feature-lifecycles.md`、`entity-ids-and-correlation.md`、`provider-capability-system.md`、`provider-switching-and-context.md`；`docs/user/` 的 `thread-sidebar.md`、`permission-modes.md`、`portable-handoffs.md`、`remote-access.md`、`providers-pi.md`；契约 `packages/contracts/src/orchestratorMcp.ts`。只读，不拷代码。

| 文件 | 内容 |
|---|---|
| 本文 | §0 结论；§1 目标与非目标；§2 场景；§3 机制与 Provider 注入；§4 t3code 对照；§9 需要维护者决定 |
| [P6-multi-agent-tools](P6-multi-agent-tools.md) | §5 工具面；§6 生命周期；§7 上下文传递；§8 界面 |
| [P6-multi-agent-security](P6-multi-agent-security.md) | §S 安全模型；§E 证据与用量 |
| [P6-multi-agent-plan](P6-multi-agent-plan.md) | §P 性能；§D 依赖；§W 阶段与工期；§T 测试 |

## 0. 结论

1. P4 只是 t3code Orchestration V2 核心（命令、事件、projection、outbox）的对应物。委派、等待、取消、跨会话消息、定时任务、权限上限、会话凭据是其上的另一层，本文称 P6。P4 已为它预留钩子，P6 不再改核心。
2. 机制：daemon 为每个启用委派的 Provider run 开一个 Scry 自有的编排 MCP 端点（loopback HTTP、单 run token）。Agent 调工具，工具变成 P4 命令。先例已在：历史检索服务 `scry_history`（`conversation-history-reader.ts:150-243`）已注入 Claude、Codex、Pi（`claude.ts:413-415`、`codex.ts:171-174`、`pi-run.ts:56-61`）。
3. 第一切片：本机发起的父 run；子任务在同一工作区；`capabilities`、`delegate`、`status`、`cancel`、`result_read` 五个工具；Codex 与 Qoder 真机；Claude 只有代码路径（真机 not-run）；深度 1；不自动唤醒父会话。约 6 周（5.5–6.5），不含 P4。
4. 难点在 Provider：Codex 的 MCP 配置是 app-server 进程级，每 run 一份凭据就要每 run 一个专用 client；OpenCode 的 MCP 写在按 cwd 池化的 server 配置里，第一切片 unavailable；Pi 只有 `full_access`（§3.3）。
5. 安全：一个 Agent 能启动 Agent。权限只降不升；`full_access` 子任务另需用户为该会话打开；每个子 run 照常过工作区授权与 trust gate（fail closed）；actor 记为 Agent，从不显示为用户批准；Agent 不能回答审批与提问；凭据只在内存、随 run 撤销；深度、扇出、并发有上限（[security](P6-multi-agent-security.md)）。

## 1. 目标与非目标

**目标**

- 父 Agent 把子任务委派给 Scry 自有的子会话，取回结果；子会话可换 Provider，可并行。
- 创建、派发、结果、取消都是 P4 命令与事件；重启后每个子任务有可证明的结局。
- 用户在父会话里看到子任务、回答子任务的审批、一次停止整棵树。
- 谁发起可审计：用户（哪个 grant）还是 Agent（哪个会话、哪个 run、经哪份凭据）。

**非目标**

- 不替换 Provider 原生子 Agent（Claude 的 Task、Codex 的协作、Qoder 与 Pi 的子 Agent）。它们照旧按轨迹观测，轮次角色由 Provider 声明（`recorder-lifecycle-events.ts:235`）。
- 不是安全沙箱。子 run 与父 run 一样以本机用户权限运行（AGENTS 开头）。
- Agent 不能配对设备、建立连接、改设置、回答审批。
- 第一切片不把父会话历史交给子任务，不做跨 Provider 的历史交接。

## 2. 场景

| 场景 | t3code | 本文 | 切片 |
|---|---|---|---|
| 委派一个子任务并取回结果 | `delegate_task`、`task_status` | `scry_task_delegate`、`scry_task_status` | 第一 |
| 并行扇出 | 多次委派；`create_threads` 一次 1–20 个普通线程 | 多次委派，受扇出上限；不做批量创建 | 第一 |
| 跨 Provider | `target.providerInstanceId` | `target.providerId` / `agentProfileId`，受权限上限与注入能力约束 | 第一（Codex↔Qoder） |
| 工作树隔离 | `isolation: 'worktree'`，不带父的未提交改动 | 复用 `createWorkspaceWorktree`（`workspace-git.ts:76-83`） | 第二 |
| 另一台已配对执行机 | 已链接环境 + `target.environmentId` | 经执行目标转发（`execution-targets.ts`），需新能力 | 以后 |
| Agent 给别的会话发消息、等待、打断 | `t3_thread_send` / `wait` / `interrupt` | `scry_session_*` | 以后（第三） |
| 定时任务 | `schedule_task`（间隔、定时、webhook） | 不做；另立设计，依赖 P5 | 以后 |
| 子任务的审批、提问出现在父会话 | 审批在父会话界面；提问通知父 Agent | 审批与提问都只给用户，在父会话出现 | 第一 |
| 子任务完成后唤醒父会话 | 默认唤醒 | 不做（D5） | 以后 |

## 3. 机制

### 3.1 选择

| 方案 | 说明 | 结论 |
|---|---|---|
| A. Scry 自有编排 MCP，每 run 注入 | 同 t3；跨 Provider；每次调用是 P4 命令，可限权、可审计 | **推荐** |
| B. 借用 Provider 原生子 Agent | 只在同一 Provider 内；Scry 只能观测，不能派发、限权、跨 Provider | 不采用 |
| C. Agent 调 Scry 命令行 | 凭据要落盘或进环境；P5 运行标记本就拦 Agent 调宿主命令行（[P5-host-security](P5-host-security.md) §4.2）；输出无结构 | 不采用 |
| D. 用户手动拆分 | 已有侧聊与原生分叉 | 不是本文目标 |

### 3.2 端点

- **位置**：daemon 内（R11）。每个启用委派的 run 一个 loopback 端点，做法同历史检索：随机端口、32 字节随机 token、校验 `Host`、拒绝带 `Origin` 的请求、`timingSafeEqual`、请求体与连接数上限（`conversation-history-reader.ts:151-153`、`:181-183`、`:222-226`）。run 终态即关闭（同 `:146-148` 的约定）。
- **名称**：服务名 `scry_orchestrator`，与 `scry_history` 并列。与仓库 MCP 重名时拒绝投递，同 `claude.ts:393`。
- **代理**：把 loopback 加进 `NO_PROXY`（`historyReaderEnvironment`，`conversation-history-reader.ts:22-25`）。
- **能力位**：adapter 声明 `orchestrationTools?: true`，同 `historyReader?: true`（`types.ts:246-247`）；未声明而请求委派时，registry 在启动前拒绝，同 `registry.ts:90`。
- **审批**：保留 Provider 原生的 MCP 工具审批（AGENTS §3「默认模式保留 Provider 原生/映射后的审批语义」）。**与 t3 不同**：t3 把 `mcp__t3-code__*` 加进 Claude 的 `allowedTools`；这里不自动放行。默认模式下，用户在 Provider 的审批里批准每次委派。

### 3.3 各 Provider 的注入可行性

权限档位来自 `permissionOptions`（`run-controls.ts:27-55`）在各 adapter 的调用。

| Provider | 今天的先例 | 注入路径 | 凭据绑定与复用 | 档位 | 第一切片 |
|---|---|---|---|---|---|
| Claude | `scry_history` 经 SDK `mcpServers`，`type: 'http'` + `Authorization` 头（`claude.ts:390-415`） | 同 | 每个 query 一份，无复用损失 | 四档（`claude.ts:292`） | 代码路径与单测；真机 **not-run**（未授权真实运行） |
| Codex | `scry_history` 经 `-c mcp_servers`，token 走 `bearer_token_env_var`（`codex.ts:148-176`、`:782`） | 同；或 `thread/start` 的线程级配置（t3 用这个；Scry 所用版本未验证） | 进程级：client 键含凭据哈希（`codex.ts:736-737`），每 run 专用 client、run 后关闭（`:1719`）。失去 app-server 复用，冷启动进首 token；transport 共享（`forceKillScope: 'shared_transport'`，`:1774`） | `default`、`auto_review`、`full_access`（`codex.ts:1983`） | 是；P6-0 先测冷启动、核对线程级配置 |
| Qoder | 无（未实现 `historyReader`） | SDK 的 `mcpServers` + `strictMcpConfig`（`qoder-launch.ts:171-174`），路径同 Claude | 每个 query 一份 | 四档（`qoder-catalog.ts:224`） | 是；P6-0 核对 SDK 接受 http 型 MCP 与请求头 |
| OpenCode | 无 | MCP 写进 server 配置（`opencode-server.ts:486-500`、`:883`），server 按 cwd 池化，同 cwd 的会话共用（`opencode-server-pool.ts:114-117`） | 按会话发凭据就要每会话一个 server；配置文件会把 token 落盘（0600 临时目录），违反「不落盘原始凭据」，除非 OpenCode 支持在配置里引用环境变量（未验证） | `default`、`full_access`（`opencode-controls.ts:44`） | **unavailable** |
| Pi | `scry_history` 经固定哈希的启动扩展（`pi-run.ts:56-61`），不进池（`:66`） | 第二个固定哈希扩展，同 t3 的 Pi 桥 | 每进程一份，冷启动 | 只有 `full_access`（`pi-catalog.ts:317-321`） | 第二切片；只能作为全权限父 run 的子任务 |

**Codex 的 code mode**：t3 记录 Codex code mode 约 30 s 让出脚本，所以它把等待类工具单独注册成直接调用。这里把等待上限定为 20 s（tools §5.1），并把该服务的 `tool_timeout_sec` 设为 30（历史检索是 10，`codex.ts:174`）。Scry 的 app-server 参数没有涉及 code mode（`codex.ts:751-758`），P6-0 核对。

## 4. t3code 对照

| 概念 | t3code（`orchestrator-mcp-server.md` 等） | 本文 |
|---|---|---|
| 入口 | 一个共享 HTTP 端点 `/mcp`，凭据按 Provider 会话 | 每 run 一个 loopback 端点与 token（历史检索先例）；actor 仍按原生会话作用域（R2、R7） |
| 凭据寿命 | 最长寿命、空闲过期、会话释放即撤销；不持久化 | 同，更短：随 run 终态撤销 |
| 工具审批 | 自动放行 | **不同**：保留 Provider 原生审批（§3.2） |
| 权限上限 | 子任务模式只等或更窄；改别的线程要调用方活跃 run，且目标不更宽 | 同；另加：`full_access` 子任务需会话级开关；`auto_accept_edits` 与 `auto_review` 不可比（security §S1） |
| 目标不提供的模式 | 继承的模式退到目标提供的最宽模式；显式请求则拒绝 | **不同**：不自动降档。拒绝并列出可用档位，由 Agent 显式请求一个不更宽的档位（`runtime-types.ts:49-53`「不得静默降档」） |
| 子任务上下文 | 只有任务提示与可选角色说明 | 同 |
| 子任务提问 | 通知父 Agent，父 Agent 可代答 | **不同**：只给用户 |
| 子任务审批 | 父会话界面，不路由给 Agent | 同 |
| 完成后 | 唤醒父线程 | 第一切片不唤醒（D5） |
| Stop | 深度优先停止全部委派任务，提交后由 effect 发出 | 同；单线程决策器在同一事务完成（R5） |
| 幂等 | `clientRequestId` 推导稳定 id，按 Provider 会话 | 同（R7）；只读工具不写回执 |
| 谱系 | `parentThreadId`、`relationshipToParent: fork \| subagent`、`ContextTransfer` | `lineage`（R1），沿用 Scry 的原生分叉与侧聊名称 |
| 来源 | `createdBy` 与 `creationSource` 分开 | `actor` 与 `author` 分开（R2、R3） |
| 跨机 | 已链接环境，链接 30 天，上限取较窄者 | 以后；配对只由用户完成（security §S6） |
| 定时任务 | 间隔、定时、webhook；无签名的 webhook 谁都能触发 | 不做 |

## 9. 需要维护者决定

| # | 问题 | 建议 |
|---|---|---|
| D1 | 机制 | Scry 自有编排 MCP，每 run 注入（§3.1 A） |
| D2 | 开关 | 默认关；按项目打开，会话里常驻显示状态。理由：每个父 run 多一个端点，Codex 失去 client 复用 |
| D3 | 第一切片 | 本机父 run、同工作区、五个工具、Codex 与 Qoder、深度 1、无自动唤醒（§0 第 3 条） |
| D4 | 权限的序与降档 | 偏序：`default` ≤ `auto_accept_edits`、`auto_review` ≤ `full_access`，中间两档不可比（代码注释称四档栈升，`runtime-types.ts:49-53`，效果上不成立）。不自动降档：目标不提供继承的档位时拒绝并列出可用档位，由 Agent 显式请求。备选是 t3 的自动退档并在任务卡写明，与「不得静默降档」有张力，不推荐 |
| D5 | 子任务完成后唤醒父会话 | 第一切片不做。自动唤醒会在无人时派发新一轮，可能带 `full_access`，并把子任务输出直接送进父 Agent |
| D6 | `full_access` 子任务 | 父 run 是 `full_access` 也不够，另需用户在该会话打开「允许子任务完全访问」，默认关。AGENTS §3：`full_access` 是用户的明确选择，Agent 启动的子会话不是 |
| D7 | 上限数值 | 深度 1；每父 run 同时 4 个、共 8 个；宿主 Agent 发起的未终态 run 8 个；每 run 每分钟 6 次。暂定，随数据调 |
| D8 | Agent 回答子任务的提问 | 不允许；审批永不。t3 允许父 Agent 代答提问 |
| D9 | 远程发起的父 run 能否委派 | 第一切片不能（远程设备上的用户多半不在看） |
| D10 | 子会话对用户是否可写 | 只读：可停止、可回答审批，不能发消息（同 t3） |
| D11 | 编排工具的原生审批 | 保留（与 t3 不同） |
| D12 | OpenCode 与 Pi | OpenCode 第一切片 unavailable，P6-0 查清动态 MCP 或环境变量引用后再议；Pi 第二切片 |
| D13 | 定时任务、跨机委派、会话消息 | 各自另立设计；定时任务等 P5 落地 |
| D14 | 术语 | 委派任务、子会话、发起者（actor）、代表的用户（principal）。概念确认后在实现提交里补进 GLOSSARY，本草案不改 |
