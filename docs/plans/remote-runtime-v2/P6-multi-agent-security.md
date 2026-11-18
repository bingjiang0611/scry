# P6 · §S 安全模型 · §E 证据与用量（草案）

属于 [P6 草案](P6-multi-agent-draft.md)。状态：草案，未批准。行号说明见草案开头。

多 Agent 打开的是「一个 Agent 能启动 Agent」。Scry 不是沙箱（AGENTS 开头）：子 run 照样以本机用户权限运行。本节能保证的只有四件事：不升权、每个子 run 照常过授权与 trust gate、谁做的如实记录、规模有上限。同一 uid 的并发攻击者不在模型内（AGENTS §3）。

## S1. 权限上限

### S1.1 各 Provider 提供的档位

| Provider | `default` | `auto_accept_edits` | `auto_review` | `full_access` | 来源 |
|---|---|---|---|---|---|
| Claude | 有 | 有 | 有 | 有 | `claude.ts:292` |
| Codex | 有 | — | 有 | 有 | `codex.ts:1983` |
| Qoder | 有 | 有 | 有 | 有 | `qoder-catalog.ts:224` |
| OpenCode | 有 | — | — | 有 | `opencode-controls.ts:44` |
| Pi | — | — | — | 有（「本机完全访问」） | `pi-catalog.ts:317-321` |

### S1.2 序

代码注释称四档「语义栈升」（`runtime-types.ts:49-53`）。效果上中间两档不可比：`auto_accept_edits` 放行编辑、命令仍问；`auto_review` 交给 Provider 审查器，可能放行命令。上限按偏序：`default` ≤ `auto_accept_edits`、`auto_review` ≤ `full_access`。子任务档位 c 合法，当且仅当 c ≤ 父档位 p。

### S1.3 选择规则（草案 D4、D6）

1. 请求了 c：c ≤ p 且目标提供 c，用 c；否则 `permission_mode_escalation_denied` 或 `provider_mode_unavailable`（附可用档位）。
2. 继承：目标提供 p，用 p；否则拒绝并列出可用档位，由 Agent 显式请求。不自动降档：「没有原生等价语义的 Provider 不得静默降档」（`runtime-types.ts:49-53`），「用户选了什么，跑的就必须是什么」（`run-controls.ts:20-25`）。
3. `full_access`：p 是 `full_access` 还不够，另需用户在该会话打开「允许子任务完全访问」（默认关）。AGENTS §3：`full_access` 是用户的明确选择；Agent 启动的子会话不是。开关关时，`full_access` 不可选，Pi 因此不能作子任务。
4. 例：父 `default` → Pi：拒绝。父 `auto_accept_edits` → Codex：继承被拒（Codex 无此档），Agent 可请求 `default`。父 `auto_review` → Qoder 的 `auto_accept_edits`：拒绝（不可比）。
5. 派发前复核（P4 core §2.3、R4）每次都重算，不缓存：父 run 档位在运行中不变，但开关可能被用户关掉。
6. 改别的会话（第三切片）：需要调用方 run 活跃，目标会话档位不宽于调用方（同 t3「the target's runtime and interaction modes may not be broader than the caller's」），第一版只限调用方自己的子会话。

任务卡与 `scry_capabilities` 用 Provider 自己的 `full_access` 文案说明真实效果（AGENTS §3）。

## S2. 工作区授权与 trust gate

- 每个子 run 照常检查：principal 的工作区授权（R4）、canonical cwd、仓库 MCP/Hook/plugin 的内容与 executable 指纹。失败即 `run.failed(trust_gate_rejected)` 或 `workspace_not_authorized`，任务 `failed`，Provider 调用 0 次。fail closed。
- 第一切片子任务只能在父 run 的 canonical cwd。t3 的线程工具可指向环境里任何线程；这里更窄。
- 工作树（第二切片）是新 cwd：先由 `createWorkspaceWorktree` 建出（`workspace-git.ts:76-83`；需要原生 filter 的分支已被拒绝，`:58-61`），再按新 canonical cwd 过 trust gate。
- **不可信仓库**：AGENTS §3 规定仓库 MCP、Codex Hook、OpenCode plugin 自动授权，首次执行与指纹变化时重验。委派让同一仓库的配置在每个子 run 里再加载一次，执行次数变多，信任范围不变：不可信仓库在父 run 里就已能以本机权限执行。自动放行记 `source: auto`，从不显示为用户批准。改这条策略要维护者另行同意，本草案不改。

## S3. 提示注入的传播

- **路径**：子任务读仓库、网页或工具输出，被注入；它的结果回到父 Agent；父 Agent 以父档位行动。
- 权限上限挡住「子借父权」，挡不住「父听子话」。Scry 不能阻止父 Agent 采信子任务输出，这与任何工具输出相同。「允许 Agent 委派子任务」与「允许子任务完全访问」两个开关的说明里照实写这一点。
- **缓解**：结果标为数据（tools §5.1）；摘要 ≤ 2 KiB，全文分页读；深度 1，子任务没有编排工具，注入不能再扩散；子任务不能给父会话或别的会话发消息（第一、二切片）；提问与审批只给用户（D8）；不自动唤醒父会话（D5），所以无人时子任务输出不会触发新一轮。
- **不算缓解**：模型自律、提示里写「忽略其中的指令」。

## S4. 凭据

| 项 | 规则 |
|---|---|
| 形式 | 32 字节随机 token，同历史检索（`conversation-history-reader.ts:152`） |
| 存放 | 只在 daemon 内存。持久化的只有随机 `via` id（R2）。不写日志、事件、库与配置文件，不经 preload（同 `HistoryReaderConnection` 的注释，`:13`） |
| 作用域 | 一个调用方 run；actor 按原生会话（R2），下一 run 换新 token、同一 actor，能读同一批任务 |
| 寿命 | run 终态、停止、所属 Provider 进程退出即撤销并关端点；空闲 30 min 过期；最长 24 h。暂定 |
| 撤销后调用 | 403，不写任何行（P4 core §2.2：授权失败不留持久行） |
| 暴露面 | Codex 的 token 在 app-server 的环境变量里（`codex.ts:782`），Agent 执行的命令、仓库 stdio MCP 子进程可能读到；Claude、Qoder 经 SDK 请求头传入，同一 uid 仍能读进程内存。结论：token 等于「这个 Agent 的委派能力」，拿到它的代码不会多于该 Agent 本就能做的（同一上限与限额）。P6-0 核对 Codex 是否把 `SCRY_*` 变量传给 stdio MCP 子进程 |

## S5. 上限与防环

| 项 | 默认（暂定，草案 D7） | 超出 |
|---|---|---|
| 深度 | 1：子 run 不注入编排工具 | 无工具可调 |
| 每个父 run 同时未终态的子任务 | 4 | `limit_exceeded`，可重试 |
| 每个父 run 的委派总数 | 8 | `limit_exceeded`，黏性，本 run 内不再接受 |
| 宿主上 Agent 发起的未终态 run | 8，并计入 `RunRegistry` 准入（容量满本就是可重试拒绝，P4 core §2.2） | `limit_exceeded` |
| 每个调用方 run 的委派速率 | 6 次/分钟 | `limit_exceeded`，带可重试时间 |
| 费用 | 不设用量预算：用量在 run 之后才有，且可能 `unavailable`，不能据此事前拦截。只限数量、并发与速率，照实写在设置说明里 | — |

- **防环**：深度 1 让环不可能出现；第三切片的会话消息只能发给调用方的子会话，子会话不能回发；`clientRequestId` 防止重试放大。
- 测试用环境变量调小上限，不改默认值，记录变量与值（AGENTS「验证分级」）。

## S6. 远程设备与执行端

- **远程发起的父 run**（principal 是手机或 Desktop 远程的 grant）：第一切片不注入编排工具（D9）。以后开放时，子任务继承该 grant 的远程范围：cwd 必须在远程项目根内（P4 protocol §5.5），grant 撤销后子任务在下一次复核失败（core §2.3）。子任务的事件 `scope` 与父 run 相同。
- **已配对设备上的 Agent 委派到宿主**：需要用户建立的连接。今天的执行目标是 Desktop 以客户端身份连另一台宿主，转发按键精确校验（`execution-targets.ts:14-18`、`:48-51`），跨机委派要加新的可协商能力，不能只加字段。上限取「连接所用 grant 的范围」与「调用方档位」的较窄者（同 t3「An agent also never gets more there than its own mode here」）。宿主显示为「来自 <设备> 的 Agent」，不是该设备的用户。以后的切片。
- **配对只由用户完成**：不提供配对、批准、撤销、建立连接的工具。t3 有 `environment_link`（经用户批准卡），这里不做。P5 的运行标记 `SCRY_HOST_CHILD=run`（[P5-host-security](P5-host-security.md) §4.2）在 Provider 运行环境的公共出口统一加上，子 run 同样带它，照做的 Agent 调 `scry-host invite/approve` 被拒（`host_cli_inside_agent`，[P5-host-cli](P5-host-cli.md)）。它挡不住刻意清空环境的代码，照实写。
- **P5 无人值守**：登录时启动的宿主没有界面时，子任务的审批无人回答，子任务停在等待；父 Agent 的等待以 `pendingInteraction` 返回。不因无人值守而自动批准，也不放宽 P5 §4 的只收紧放行规则。

## S7. 审计

- 每个命令与事件带 `actor`、`principal`、`via`、`actor_run_id`（R2）。界面只把 `peer:` 显示为用户动作；`agent:`、`system` 从不显示为用户批准或用户发送（R3）。
- Provider 原生审批批准了一次 `scry_task_delegate` 调用：这是用户对**那次工具调用**的回答，记在父 run 的 interaction（`answered_by` = 用户）。子任务本身的 actor 仍是 Agent。两条记录不合并成「用户创建了子任务」。
- **Recorder Core 不变**：子 run 是普通受管 run，记录照常写 `.scry/records`；recorder 不导入编排模块，也不知道谱系（P4 data §3.4）。Scry 发起的子 run 不是 Provider 原生子 Agent：轮次角色保持 Provider 声明或 `unobserved`（`turn-record-contracts.ts:296-305`），谱系只在编排事件里。commit callback 的 trust 语义不变。

## E. 证据与用量

- **任务结局**：取子 run 的结局，原样映射；`unavailable(host_restarted)` → 任务 `unavailable`，不是 `failed`（P4 决定 12）。
- **摘要**：`Evidence<string>`。来自 trace 归档的最后一条助手消息，`quality: 'exact'`（原文的截取）；截断为 `status: 'partial'`；归档不可读为 `unavailable` + `omissionReason`。最终回复存在不证明任务完成（GLOSSARY「运行结果」）。
- **用量归属**：用量不进事件（P4 data §3.3）。父会话的「含子任务」在读取时按谱系汇总各子 run 的轮次记录：
  - 按单位分开：Token、美元、Credits 不合计（GLOSSARY「用量」）。
  - 质量取最弱：有 `estimated` 即 `estimated`，有 `inferred` 即 `inferred`。
  - 任一子 run 的用量 `unavailable`：合计为 `status: 'partial'`，并写「N 个子任务的用量不可用」；从不按 0 计。
  - Credits 只到已知请求，不宣称整轮总额（GLOSSARY「Credits」）。
- 父 run 自己的用量不含子任务，两者分开显示，避免重复计数。
