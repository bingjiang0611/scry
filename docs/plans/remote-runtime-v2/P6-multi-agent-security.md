# P6 · §S 安全模型（草案）

属于 [P6 草案](P6-multi-agent-draft.md)。状态：草案，未批准；评审后修订 2026-11-19。行号说明见草案开头。证据与用量移到 [evidence](P6-multi-agent-evidence.md)。

多 Agent 打开的是「一个 Agent 能启动 Agent」。Scry 不是沙箱（AGENTS 开头）：子 run 照样以本机用户权限运行。本节能保证的只有五件事：同一 Provider 内不升权；每个写操作由用户在 Scry 里确认；每个子 run 照常过授权与 trust gate，且仓库配置与用户最近一次亲自运行时相同；谁做的如实记录；规模有上限。同一 uid 的并发攻击者不在模型内（AGENTS §3）。

## S1. 权限上限

### S1.1 同名档位，效果不同（B1）

| 档位 | Claude | Qoder | Codex |
|---|---|---|---|
| `default` | SDK 默认档，编辑与命令都经 `canUseTool` 询问（`agent-runner.ts:279-288` 不设档位；`:382-397` 询问） | 同 Claude（`qoder-launch.ts:141-147`、`qoder-run-permissions.ts:56-66`） | `workspace-write` 沙箱 + `on-request`：工作区内编辑**不经审批**（`codex.ts:63-66` 注释、`:71-75`） |
| `auto_accept_edits` | SDK `acceptEdits`（`agent-runner.ts:285-287`） | 同（`qoder-launch.ts:147`） | 不提供，收到即报错（`codex.ts:63-67`） |
| `auto_review` | SDK `auto`（`:283-284`），Claude 侧审查 | SDK `auto`（`qoder-launch.ts:144-145`），Qoder 侧审查 | `approvalsReviewer: 'auto_review'`（`codex.ts:73`），Codex 的审查器 |
| `full_access` | `bypassPermissions`（`:279-282`） | 同（`qoder-launch.ts:141-142`） | `never` + `danger-full-access`（`codex.ts:68-70`） |

Codex 的 `default` 在编辑上等于 Claude 的 `auto_accept_edits`，又多一层 OS 沙箱；三个 `auto_review` 是三个审查器。跨 Provider 比较档位没有依据，所以**第一切片子任务只用父 run 的 Provider 与 profile**（decisions D3、§9.3 第 2 条）。

### S1.2 同一 Provider 内的序

- Claude、Qoder：偏序 `default` ≤ `auto_accept_edits`、`auto_review` ≤ `full_access`；中间两档不可比（一个放行编辑，一个把全部审批交给审查器）。代码注释称四档「语义栈升」（`runtime-types.ts:49-53`），效果上不成立。
- Codex：全序 `default` ≤ `auto_review` ≤ `full_access`。
- 子任务档位 c 合法，当且仅当 c ≤ 父档位 p。

### S1.3 选择规则

1. 缺省继承 p。同一 Provider 必然提供 p。
2. 显式请求 c：c ≤ p 则用 c；否则 `permission_mode_escalation_denied`，附可用档位。不隐式降档：「没有原生等价语义的 Provider 不得静默降档」（`runtime-types.ts:49-53`），「用户选了什么，跑的就必须是什么」（`run-controls.ts:20-25`）。
3. `full_access`：p 是 `full_access` 不够，另需「允许子任务完全访问」（§S2，默认关）。开关关时继承被拒，Agent 可显式请求更窄的档位。AGENTS §3：`full_access` 是用户的明确选择，Agent 启动的子会话不是。
4. 派发前复核（R4）每次重算：开关可能已被关掉。
5. 例：Claude 父 `auto_review` 请求 `auto_accept_edits`：拒绝（不可比）。Codex 父 `default` 请求 `auto_review`：拒绝（升档）。

任务卡与 `scry_capabilities` 用 Provider 自己的 `full_access` 文案（AGENTS §3）。

### S1.4 跨 Provider 的前提（以后）

先有一张逐 (Provider, 档位) 的效果表：编辑、命令、网络、OS 沙箱四列，每格有代码或真机依据。上限按「每一列都不更宽」判定，任何一格不明即不可比、拒绝。S1.1 只有编辑与审批有代码依据，网络与沙箱两列未核对；表不完整前不开放。

## S2. 两个开关

| 开关 | 默认 | 作用域 |
|---|---|---|
| 允许 Agent 委派子任务 | 关 | 项目（canonical cwd） |
| 允许子任务完全访问 | 关 | 会话 |

- 只能在本机 App 里改。改之前由 main 弹原生确认框（不是 renderer 弹窗），写明 S8 的「父听子话」与 Provider 自己的 `full_access` 文案。
- 存为只接受 `peer:` 且 grant 为 `scope: local` 的命令，有回执与事件。远程设备与 `agent:` 发这两条命令一律拒绝；远程只能看状态。
- 派发前复核每次重读当前值。关闭只影响尚未派发的子 run；已派发的由用户停止。

## S3. 工作区授权与 trust gate

- 每个子 run 照常检查 principal 的工作区授权、canonical cwd、仓库 MCP/Hook/plugin 的内容与 executable 指纹（R4）。失败即 `run.failed(...)`，任务 `failed`，Provider 调用 0 次。
- 第一切片子任务只能在父 run 的 canonical cwd。工作树（第二切片）先由 `createWorkspaceWorktree` 建出（`workspace-git.ts:77-83`；需要原生 filter 的分支已被拒，`:58-61`）。
- **Agent 发起的 run 另加一条（D15，B2）**：子 run 的仓库配置指纹（MCP、Hook、plugin、Provider 项目设置）必须等于同一 Provider、同一 canonical cwd 上**最近一次用户发起的 run** 授权的指纹。没有这样的 run，或指纹不同：`run.failed(trust_gate_rejected)`，fail closed。
  - 理由：2026-09-21 的自动授权（`mcp-execution-trust.ts:813-824`、`bootstrap/trust.ts:216-226`）以「用户打开并运行」为前提。父 Agent 能改仓库配置（加 Hook、加 MCP、在项目设置里预先放行工具），再让子 run 以新配置执行，跳过用户这一步。
  - 只收紧 Agent 发起的 run；用户发起的 run 照旧自动授权，不变。
  - Provider 项目设置：Claude 不传 `settingSources` 时读 user、project、local 三处（`claude.ts:165-174`；SDK 说明 `sdk.d.ts:2046-2056`），Qoder 固定读三处（`qoder-launch.ts:167`）。今天的执行指纹不含它们，P6-1 扩展，文件清单由 P6-0 核对。
  - 基线在 daemon 内存，键 (Provider, canonical cwd)。daemon 重启后为空，Agent 子任务被拒，直到用户亲自运行一次。
  - 工作树不算新的首次授权：它的内容指纹必须等于源 cwd 的基线。
  - 相互作用：`scry init` 写 `.claude/settings.local.json`、`.codex/hooks.json`、`.qoder/settings.json` 与 OpenCode plugin（`workspace-hook-sources.ts:31-33`、`workspace-init.ts:116-127`），指纹因此改变；之后 Agent 子任务被拒，直到用户在该 cwd 用该 Provider 运行一次。拒绝原因写明这一点。
- 自动放行仍记 `source: auto`，从不显示为用户批准。改 2026-09-21 的策略本身要维护者另行同意，本草案不改。

## S4. 凭据（D16，B3）

| 项 | 规则 |
|---|---|
| 通道 | Claude、Qoder：SDK 进程内 MCP（`type: 'sdk'`），无端口、无 token。Codex：`thread/start` 的线程级请求头，走 app-server 的 stdin JSON-RPC。**从不进 argv、环境变量、配置文件**；做不到的 Provider unavailable，不退回 |
| 不进 argv | 两个 SDK 把非 sdk 型 `mcpServers` 连同请求头写进 CLI 的 `--mcp-config` 参数（F1，decisions §10.2）。参数经 `ps` 对本机其他用户可见，越出 AGENTS §3 的同 uid 前提 |
| 不进环境 | 环境由 Agent 执行的命令与 stdio MCP 子进程继承；Codex 是否滤掉 `*TOKEN*` 变量未核对（P6-0） |
| 形式与存放 | Codex 端点：32 字节随机（同 `conversation-history-reader.ts:152`），只在 daemon 内存。持久化的只有随机 `via` id |
| 寿命 | 绑定一个调用方 run；run 终态、停止、所属 Provider 进程退出即撤销。**不设空闲过期**：等待子任务的父 run 可能很久不调用，空闲过期会让它在用户不知情时失去能力。run 的寿命即上限 |
| 撤销后 | 拒绝，不写任何行（P4 core §2.2） |
| 暴露面 | 进程内 MCP 没有可偷的凭据；Codex 请求头在 app-server 内存里，同一 uid 能读，不在模型内 |

**P6 之外的已知问题（记录，不在此修）**：今天历史检索给 Claude 的 `Authorization: Bearer <token>` 走 http 型 `mcpServers`（`claude.ts:413-415`），被 SDK 写进 `--mcp-config` 参数，本机其他用户可经 `ps` 看到。Qoder 没有历史检索；Codex、Pi 走环境变量（`codex.ts:782`、`pi-run.ts:62-64`），只对同一 uid 可见。修法另候维护者决定。同类的仓库 MCP `headers`/`env` 见 decisions §10.3。

## S5. 上限与防环（D7）

| 项 | 默认（暂定） | 超出 |
|---|---|---|
| 深度 | 1：子 run 不注入编排工具 | 无工具可调 |
| 每父 run 同时未终态的子任务 | 4 | `limit_exceeded`，可重试 |
| 每父 run 的委派总数 | 8 | `limit_exceeded`，本 run 内黏性 |
| 宿主 Agent 发起的未终态 run | 8，按 `orch_p_run.origin = 'agent'` 计数（R12）。宿主今天没有全局并发上限，准入只按会话键串行（`context-admission.ts:77-79`），所以这是 P6 自己的计数：用户 run 不计入，也从不因它被拒。以后若加宿主容量，Agent run 只用「容量 − 预留」，预留暂定 2 | `limit_exceeded` |
| 写工具 | 每调用方 run 6 次/分钟 | `limit_exceeded`，带可重试时间 |
| 读工具 | 每调用方 run 60 次/分钟（B6） | 同上 |
| 子任务等用户 | 子 run 的审批或提问开着超过 30 min：停止子 run，任务 `unavailable(interaction_timeout)`；不自动批准 | — |
| 费用 | 不设预算：用量在 run 之后才有，且可能 `unavailable`。只限数量、并发与速率，照实写在设置说明里 | — |

- 防环：深度 1；`clientRequestId` 防重试放大（tools §5.1）。
- 测试用环境变量调小上限，不改默认值，记录变量与值。

## S6. Scry 确认与工具策略（D11，取代首稿「保留原生审批」）

原生审批挡不住委派（B4）：逐次弹窗让一个 10 分钟的子任务带来约 30 次询问；原生「本会话允许」一次之后全部免问（`agent-runner.ts:380`、`qoder-run-permissions.ts:57`）；仓库项目设置可预先放行 `mcp__scry_orchestrator__*`（§S3）；`auto_review` 交给审查器，`full_access` 不审批。

| 工具 | 原生审批 | Scry 确认 |
|---|---|---|
| `scry_capabilities`、`scry_task_status`、`scry_task_result_read` | adapter 自动放行，四档相同（维护者同意，decisions §9.2） | 无 |
| `scry_task_delegate`、`scry_task_cancel` | 保留 Provider 原生语义（是否也放行待决定，decisions §9.3 第 1 条） | **每次都要**，四档相同，`full_access` 父 run 也要 |

| Provider | adapter 如何放行读工具 |
|---|---|
| Claude、Qoder | `canUseTool` 对三个精确名字 `mcp__scry_orchestrator__<tool>` 返回 allow；不放行前缀，不写会话规则 |
| Codex | MCP 工具调用的原生审批路径与注解未核对（P6-0）。若 Codex 发审批请求，adapter 对三个名字自动回答 allow；若不发则无需处理 |

确认的做法：

- 写工具立即返回 `status: 'awaiting_confirmation'` 与 `taskId`，不阻塞调用（Qoder 控制请求 30 s 超时，`qoder-launch.ts:175`；Codex 有 `tool_timeout_sec`）。
- 决策器在父 run 上开一个 Scry 自有的 interaction，显示在父会话：标题、正文预览、Provider、实际档位与来源。没有「本会话都允许」。
- 只有 `peer:` 能回答，`answered_by` 记该 peer；`agent:` 的回答一律拒绝（D8）。第一切片只有本机 App 能回答。
- 批准后才在同一事务里创建子会话与子 run（tools §6.1）；拒绝则任务 `declined`；父 run 终态或停止时关闭，任务 `cancelled(caller_run_ended)`。

## S7. 远程设备与执行端

- **注入条件（D9）**：父 run 由本机 grant 发起，且派发时 daemon 上有本机 App 的订阅连接（P4-3）。这只说明 App 开着，不证明有人在看，照实写。远程发起的父 run 不注入。以后开放时，子任务继承该 grant 的远程范围（P4 protocol §5.5），grant 撤销后在下一次复核失败。
- **跨机委派**：要新的可协商能力（`execution-targets.ts:14-18`、`:48-51` 按键精确校验），上限取连接 grant 与调用方档位的较窄者。以后。
- **配对只由用户完成**：不提供配对、批准、撤销、建立连接的工具。子 run 同样带 P5 运行标记 `SCRY_HOST_CHILD=run`（[P5-host-security](P5-host-security.md) §4.2），照做的 Agent 调 `scry-host invite/approve` 被拒；挡不住刻意清空环境的代码。
- **P5 无人值守**：没有界面时 Scry 确认与子任务审批都无人回答。确认停在等待；子任务等用户到 S5 的上限后 `unavailable(interaction_timeout)`。不自动批准。

## S8. 提示注入的传播

- 路径：子任务读仓库、网页或工具输出，被注入；结果回到父 Agent；父 Agent 以父档位行动。上限挡住「子借父权」，挡不住「父听子话」，与任何工具输出相同。两个开关的确认框照实写这一点。
- 缓解：结果标为数据（tools §5.1）；摘要 ≤ 2 KiB；深度 1；子任务不能发消息；提问与审批只给用户；每次委派由用户确认；不自动唤醒父会话。
- 不算缓解：模型自律、提示里写「忽略其中的指令」。

## S9. 审计

- 每个命令与事件带 `actor`、`principal`、`via`、`actor_run_id`（R2）。界面只把 `peer:` 显示为用户动作；`agent:`、`system` 从不显示为用户批准或用户发送（R3）。
- 用户对一次委派的 Scry 确认记在父 run 的 interaction（`answered_by` = peer）。子任务的 actor 仍是 Agent；两条记录不合并成「用户创建了子任务」。
- Recorder Core 不变（D17、D27）：子 run 是普通受管 run，照常写 `.scry/records`；recorder 不知道谱系（P4 data §3.4）。轮次角色保持 Provider 声明或 `unobserved`（`turn-record-contracts.ts:295-305`）。
