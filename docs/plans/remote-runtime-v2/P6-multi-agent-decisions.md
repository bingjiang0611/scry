# P6 · §9 决定 · §10 评审核对（草案）

> **暂停（维护者 2026-11-23）**：先完成 [V2 对齐](V2-alignment.md)（任务单 W20），再按其 §E 更新依赖后恢复。

属于 [P6 草案](P6-multi-agent-draft.md)。状态：草案，未批准。2026-11-19 独立评审之后新拆出；首稿的 §9「需要维护者决定」移到这里。行号说明见草案开头。

## 9. 决定

### 9.1 已决定（维护者 2026-11-19）

首稿 D1–D14 按维护者裁定改写；D15 起是评审指出首稿缺少、本次一并裁定的。「暂定」的数值随数据调，不另立决定。

| # | 问题 | 结论 | 落地 |
|---|---|---|---|
| D1 | 机制 | Scry 自有编排 MCP。Claude、Qoder 用 SDK 进程内 MCP；Codex 用 daemon 内一个 loopback 端点，凭据按 run，经 `thread/start` 的线程级请求头传入 | 草案 §3.2 |
| D2 | 开关 | 默认关，按项目打开。两个开关都只能在本机 App 里改，main 弹原生确认框；存为只接受 `peer:` 的命令；派发前复核重读 | security §S2 |
| D3 | 第一切片 | **只在同一 Provider 内委派**；本机发起、本机 App 在场的父 run；同工作区；五个工具；Codex 与 Qoder 真机、Claude 代码路径；深度 1；无自动唤醒 | 草案 §0 |
| D4 | 档位上限 | 只在同一 Provider 内比较，保持偏序（Claude/Qoder 中间两档不可比；Codex 为全序），继承或显式请求不更宽的档位，**不隐式降档**（`runtime-types.ts:49-53`）。跨 Provider 以后再做，前提是逐 (Provider, 档位) 的效果表（编辑、命令、网络、OS 沙箱）。理由：同名档位效果不同，Codex `default` 是 `workspace-write` 沙箱且编辑免审批（`codex.ts:63-66`），Claude、Qoder 的 `default` 编辑要问（`agent-runner.ts:279-288`、`qoder-launch.ts:141-147`）；三个 `auto_review` 是三个审查器 | security §S1 |
| D5 | 完成后唤醒父会话 | 第一切片不做 | 草案 §2 |
| D6 | `full_access` 子任务 | 父 run 是 `full_access` 也不够，另需会话级开关（默认关）；且 `full_access` 父 run 的委派同样要 Scry 确认 | security §S1.3、§S6 |
| D7 | 上限 | 深度 1；每父 run 同时 4、共 8；宿主 Agent 发起的未终态 run 8，用户 run 不计入、不因它被拒；写工具 6 次/分钟、读工具 60 次/分钟；子任务等用户 30 min。暂定 | security §S5 |
| D8 | Agent 回答提问与审批 | 不允许 | security §S6 |
| D9 | 远程发起的父 run | 第一切片不注入。注入条件照实写成「派发时有本机 App 订阅者在场」，它不证明有人在看 | security §S7 |
| D10 | 子会话可写 | 只读，由决策器强制：`lineage.kind = 'delegated'` 的会话拒绝 `peer:` 发送；把它显示成普通会话的旧客户端同样被拒 | tools §8 |
| D11 | 编排工具的审批 | **取代首稿「保留原生审批」**：每个写工具都由挂在父 run 上的 Scry 自有确认决定，`answered_by` 只能是 peer，从不是 Agent；读工具由 adapter 自动放行（§9.2）；逐 Provider、逐档位的策略表见 security §S6 | security §S6 |
| D12 | OpenCode 与 Pi | OpenCode unavailable。Pi 第二切片，前提是 P6-0 找到不经 argv 与环境变量的凭据通道，否则 unavailable | 草案 §3.3 |
| D13 | 定时任务、跨机委派、会话消息 | 各自另立设计 | 草案 §2 |
| D14 | 术语 | 委派任务、子会话、发起者（actor）、代表的用户（principal）；实现提交里补进 GLOSSARY，本草案不改 | — |
| D15 | Agent 发起 run 的仓库配置（B2） | 子 run 的仓库配置指纹（MCP、Hook、plugin、Provider 项目设置）必须等于同一 Provider、同一 canonical cwd 上最近一次**用户发起**的 run 授权的指纹；没有或不同即 `trust_gate_rejected`，fail closed。只收紧 Agent 发起的 run；用户 run 的 2026-09-21 自动授权不变（`mcp-execution-trust.ts:813-824`、`bootstrap/trust.ts:216-226`）。工作树不算新的首次授权。`scry init` 改 Hook 配置后，Agent 子任务被拒，直到用户运行一次 | security §S3 |
| D16 | 凭据（B3） | 从不进 argv 与环境变量。做不到的 Provider unavailable，不退回。绑定 run，run 结束即撤销，不设空闲过期 | security §S4 |
| D17 | 子会话首轮的统计（E2） | 不改 recorder 合同，Recorder Core 不动；「用户轮次」统计按编排 `author` 关联排除 | evidence §E |
| D18 | 停止（B5） | `stop_requested` 在决策与复核中都算 `caller_not_active`；会话级「停止全部子任务」，只接受 peer；级联靠子 run 的 `parent_run_id`，不读可能已裁剪的父 run 行 | tools §6.3 |
| D19 | 等待（B6） | 等待按状态版本边沿触发（cursor）；读工具限速；子任务等用户超过上限即 `unavailable(interaction_timeout)` | tools §5.1 |
| D20 | 幂等（L1、L3） | 委派必须带 `clientRequestId`；命令 id 的哈希含 `actor_run_id`。理由见 tools §5.1 | tools §5.1 |
| D21 | 切换 Provider（L2） | 任务按父会话可见，不按 `bindingId`；新委派跟随当前 Provider | tools §6.3 |
| D22 | 父 run 正常结束时（L4） | 已派发的子 run 继续；尚未派发的与等确认的作废为 `cancelled(caller_run_ended)` | tools §6.3 |
| D23 | 任务 projection（L5、L6） | P6 加 `orch_p_task`，随父会话保留；结果引用指向已裁剪的事件时返回 `unavailable` 与原因 | tools §6.5 |
| D24 | 证据（评审 E1、E3、S7） | 摘要继承归档的质量，最后一条消息为空即 `unavailable`；用量各质量并列，不合成；同一工作区并行写时文件足迹与提交归属标 `partial`/`inferred` | evidence §E |
| D25 | 编排连接失败（评审 S8） | 工具显示 unavailable，run 继续 | 草案 §3.2 |
| D26 | 工期 | 第一切片 9–11 周，在 P4（及 P4 要求的 S3）之后 | plan §W |
| D27 | scry 命令行与记录格式 | 维护者决定暂不做「第 1 步」（App 发起的 run 由 daemon 直接写记录、绕过 Hook 与命令行）。P4–P6 不改 scry 命令行、其命令与记录格式 | 草案 §1 |

### 9.2 维护者同意（AGENTS §3，2026-11-19）

AGENTS §3 要求「默认模式保留 Provider 原生/映射后的审批语义」。维护者 2026-11-19 明确同意：`scry_capabilities`、`scry_task_status`、`scry_task_result_read` 三个只读编排工具在所有档位由 adapter 自动放行，不再经 Provider 原生审批。范围只限这三个工具的精确名字，不含前缀通配，不含写工具，不改其他工具的审批。理由：它们不改状态，只读调用方自己的任务；逐次原生弹窗会让一个 10 分钟的子任务带来约 30 次询问（security §S6）。

### 9.3 已决定（维护者 2026-11-19，「都按推荐」）

1. **写工具不再走 Provider 原生审批**：委派与取消只由 Scry 确认（D11）把关，adapter 放行 Provider 侧对编排写工具的审批。这改变审批语义，维护者按 AGENTS §3 于 2026-11-19 明确同意；只限 Scry 编排 MCP 的工具，不扩展到仓库或用户 MCP。
2. **同一 Provider、不同 profile**：第一切片固定为父 run 的 `agentProfileId`，不放开。
3. **P6-0 之后的范围**：若 Codex 线程级请求头与 Qoder 进程内 MCP 都不成立，按数据另报维护者决定，不退回 argv/env。
4. **跨 Provider 效果表与机器级档位上限**：第一切片之后另行设计与决定。
5. **§10.3 的已知问题**：先修 MCP 配置密钥进 argv（范围更大，可能含真实 API key），历史检索 token 一并处理；在 P6 之外单独实施。

## 10. 评审核对

### 10.1 评审意见中与代码不符或需要限定的

逐条在 `53117a8f` 上核对。成立的直接写进正文；以下需要限定：

1. **「宿主级 Agent run 上限给用户 run 留余量」（评审 S6）**：今天宿主没有全局 run 并发上限可留余量。准入只按会话键串行（`context-admission.ts:77-79`）；P4 core §2.2 的「容量满」对应台账上限（`session-ledger.ts:89`、`:309`，十万条）。首稿「计入 `RunRegistry` 准入」也不对（`run-registry.ts:1-7` 无容量字段）。改为：Agent run 由 P6 自己计数（R12），用户 run 不计入；以后若加宿主容量，Agent run 只用「容量 − 预留」（security §S5）。
2. **已知问题「Qoder 若适用同样」**：不适用。Qoder adapter 未声明 `historyReader`，没有历史检索。Codex（`codex.ts:782`）与 Pi（`pi-run.ts:62-64`）的历史检索 token 走环境变量，不在 argv；只有 Claude 进 argv（`claude.ts:413-415`）。
3. **行号小差**：Claude 默认档的映射在 `agent-runner.ts:279-288`（不设档位即 SDK 默认），`:378` 是 `full_access` 放行；历史检索 fail closed 在 `agent-runner.ts:467-469`（评审写 `:466-468`）；已知问题在 `claude.ts:413-415`（评审写 `:411-416`）。结论不变。
4. **Qoder 进程内 MCP**：仍列为 P6-0 实测，但静态核对已支持：`@qoder-ai/qoder-agent-sdk` 1.0.17 的 `dist/index.js` 导出 `createSdkMcpServer`，`type: 'sdk'` 且带 `instance` 的服务在进程内连接，不进 `--mcp-config`。
5. **「三个不同的审查器」**：Claude 与 Qoder 都映射到 SDK 的 `auto`（`agent-runner.ts:283-284`、`qoder-launch.ts:144-145`），名字相同，审查在各自服务端；Codex 用 `approvalsReviewer: 'auto_review'`（`codex.ts:73`）。结论成立。

评审给的其他依据都对得上：`codex.ts:63-66`、`:751-758`、`:1631-1632`、`:1771-1774`，`runtime-types.ts:49-53`，`qoder-run-permissions.ts:56`，`agent-runner.ts:380`，`mcp-execution-trust.ts:813-824`，`bootstrap/trust.ts:216-226`，`conversation-history-reader.ts:9`、`:181-183`，`qoder-launch.ts:175`，以及两个 SDK 把 `mcpServers` 写进 `--mcp-config`。t3code 的 `omit_tools_from` 等引用本次未重新核对。

### 10.2 首稿自身的错误（已改）

| # | 首稿 | 实际 |
|---|---|---|
| F1 | Claude、Qoder 的凭据「经 SDK 请求头传入，同一 uid 仍能读进程内存」 | 两个 SDK 把非 sdk 型 `mcpServers`（含 `Authorization` 头）序列化进 CLI 的 `--mcp-config` 参数（Claude `sdk.mjs`；Qoder `dist/index.js` 的 `buildCliMcpServers`），`ps` 跨 uid 可见 |
| F2 | 跨 Provider 委派在第一切片（Codex↔Qoder），档位按全局偏序比较 | 同名档位跨 Provider 不可比（D4）；第一切片只同一 Provider |
| F3 | 凭据「空闲 30 min 过期、最长 24 h」 | 空闲过期会让等待中的父 run 失去委派能力；改为随 run 撤销（D16） |
| F4 | 宿主 Agent run 上限「计入 `RunRegistry` 准入」 | 没有这样的准入容量（§10.1 第 1 条） |
| F5 | 级联停止对所有子 run 一样 | Codex 子 run 不带编排工具，用按 cwd 池化的 client；`forceKill` 是 `shared_transport`（`codex.ts:1771-1774`），会断同一 client 上的其他 run，所以只能 `interrupt` |
| F6 | 端点「请求体上限同历史检索」；若干行号 | 历史检索 `MAX_REQUEST_BYTES = 4096`（`conversation-history-reader.ts:9`），小于 16 KiB 的 `task`，Codex 端点单独定上限；`pi-run.ts:56-61` → `:55-64`，`:66` → `:66-67`；`workspace-git.ts:76-83` → `:77-83` |

### 10.3 P6 之外的已知问题（记录，不在此修）

1. 历史检索给 Claude 的 `Authorization: Bearer <token>` 进 `--mcp-config` 参数（`claude.ts:413-415`），本机其他用户可经 `ps` 看到。修法另候维护者决定（security §S4）。
2. 评审后核对另发现：经授权的仓库或用户 MCP 配置里的 `headers` 与 stdio `env` 同样进 argv：Codex 的 `-c mcp_servers=…`（`codex.ts:148-170`、`:775`），Claude、Qoder 的 `--mcp-config`。若其中有密钥，本机其他用户可见。未核对真实配置中的出现频率。
