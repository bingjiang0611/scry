# P7 · Antigravity CLI（`agy`）Provider（只设计）

状态：设计稿，不含实现。本文 §0–§3：已定决策、来源、传输、登录、能力矩阵。§4–§5 集成点与安全见 [P7-antigravity-integration](P7-antigravity-integration.md)；§6–§9 测试、拆分、Recorder 备注与待决定见 [P7-antigravity-plan](P7-antigravity-plan.md)。

## 0. 已定决策与来源

### 0.1 维护者决定（2026-11-19）

1. 允许真实 Antigravity run 做验证，费用记在维护者的 Google 账号。
2. 范围 (a)：Scry 驱动 `agy` 会话（发送、流式、工具、审批/提问、停止、恢复等）。不做 scry CLI / Recorder 录制终端里的 `agy`；只在 §8 记下 `agy` 是否有可用的 Hook。
3. 登录同 Codex、Qoder：Scry 不实现登录，只用 CLI 已有的登录状态。未安装、未登录如实报 unavailable 并给原因，指向 CLI 自己的登录。

### 0.2 来源与核实程度

本环境不能访问 `antigravity.google`（DNS 不通，所有官方页 fetch 失败），也未安装、未运行 `agy`。下文每条外部事实带标记：

| 标记 | 含义 |
|---|---|
| 〔T3〕 | 读自 T3 Code 源码（只读克隆 `t3code@8cf97b5f`），是 T3 对某些 `agy` 版本的实测结论，未在 Scry 复核 |
| 〔官方摘要〕 | 只见到搜索引擎对 antigravity.google 页面的摘要，未读到原文 |
| 〔社区〕 | 第三方文章、论坛帖，可信度低 |
| 〔未核实〕 | 推断，必须在 §6.2 真机清单里验证 |

没有标记的句子说的是 Scry 现状，带 `file:line`。T3 路径相对 t3code 仓库根。

## 1. 传输

### 1.1 选 ACP over stdio

| 方式 | 说明 | 结论 |
|---|---|---|
| `agy acp`（ACP v1，JSON-RPC over stdio） | 官方给 Zed/JetBrains 等编辑器的接口〔官方摘要〕；T3 用的就是它：`acp --gemini-dir … --app-data-dir …`（`apps/server/src/provider/antigravityAuthSupport.ts:459-500`）〔T3〕 | **采用** |
| `agy -p`/`--print` 无界面模式 | 一次一问，无结构化审批、无流式工具事件〔社区〕；Google FAQ 点名「把 agy 包进第三方 Agent 循环」〔官方摘要〕 | 不用 |
| 驱动 TUI（伪终端） | 解析屏幕文本，证据不可信 | 不用 |

理由：ACP 有结构化的 `session/update`（文本、思考、工具、计划）、`session/request_permission`（审批）、`session/cancel`（协作式停止）、`session/new`/`resume`/`load`（会话身份），与 Scry 的 `ProviderRunHandle`（`src/main/providers/types.ts:66-99`）一一对得上。消息走 stdin/stdout 管道，不进 argv。

ACP 是开放协议，但本期**只为 agy 写**：通用 ACP 客户端层与 agy 映射分文件，不承诺支持其他 ACP Agent（§9 D6）。

### 1.2 最低版本

- 采用 **≥ 1.5.1**。依据：T3 只接受 ≥ 1.5.0 的原生 CLI 发布（`antigravityCliRelease.ts:39`）〔T3〕；1.5.1 起 `agy acp` 对任何 ACP 客户端开放全部模型，更早版本只对白名单编辑器（如 Zed）开放非 Gemini 模型，T3 为此冒充 `clientInfo.name = "zed"`（`acp/AntigravityAcpSupport.ts:89-129`）〔T3〕。
- Scry **不冒充客户端**，固定报 `clientInfo = { name: "scry", version }`。低于 1.5.1 判 unavailable，原因写「需要 agy 1.5.1 或更高版本」。
- 1.4.2–1.4.5 会改写工作区的 `skills/system/run-workflow/SKILL.md`（`AntigravityAcpSupport.ts:68-79`）〔T3〕，版本下限也避开了它。
- 兼容性清单（`src/main/provider-compatibility-manifest.ts:53-56` 的 Qoder 条目为样板）加 `>=1.5.1` 为 `experimental`，真机通过后再按实测版本改 `supported`。

### 1.3 找到并校验二进制（对齐 Codex/Qoder）

| 步骤 | 做法 | 参照 |
|---|---|---|
| 覆盖路径 | `SCRY_AGY_PATH`，存在才用 | `SCRY_QODERCLI_PATH`（`src/main/claude-locate.ts:382-385`） |
| PATH | `which('agy')`，用 login shell PATH + 常见目录 | `claude-locate.ts:252-288` |
| 快速探测 | `KNOWN_AGENTS` 加 `{ id: 'antigravity', name: 'Antigravity', bin: 'agy' }`，冷启动只看文件是否存在 | `claude-locate.ts:373-380`、`447-452` |
| 版本 | `agy --version`，5 s 超时，`probeCliVersion` | `claude-locate.ts:317-348` |
| 协议 | 首次真正需要时（run 或目录读取）在 `initialize` 里核对 `protocolVersion === 1`、`agentInfo` 存在、`agentCapabilities.loadSession` 或 `sessionCapabilities.resume` | — |
| 身份 | 解析 `realpath` 后作为执行入口，`continuationKey` 与进程身份都哈希这个路径 | Qoder `qoderExecutable()`（`src/main/providers/qoder-launch.ts:139-143`） |

不下载、不安装、不升级 `agy`。T3 的托管安装（`AntigravityInstallation.ts`）不借鉴。

## 2. 登录状态

### 2.1 `agy` 把凭据放在哪

| 方式 | 存放 | 来源 |
|---|---|---|
| Google 账号（个人 / Gemini Enterprise）浏览器登录 | 系统钥匙串（官方文档提到 keyring 登录；WSL 等无钥匙串环境出过问题）；另有加密文件 `~/.gemini/antigravity-cli/credentials.enc` 的说法 | 〔官方摘要〕〔社区〕 |
| 强制文件存储 | `AGY_ACP_FORCE_FILE_STORAGE=1` 时写 `<gemini-dir>/<app-data-dir>/acp_token.json` | `antigravityAuthSupport.ts:228-231`、`385`〔T3〕 |
| Gemini API key | 环境变量 `GEMINI_API_KEY`；Agent Platform 用 `GOOGLE_API_KEY` | `antigravityAuthSupport.ts:213-218`〔T3〕 |
| ADC（Vertex/企业） | `gcloud auth application-default login` + `AGY_ADC_AUTH=true`；项目/区域可来自 `GOOGLE_CLOUD_PROJECT` 等 | 〔官方摘要〕 |
| 共享 | 官方说「在交互式 `agy` 里登录一次，或运行 `agy acp --login`；`agy acp` 复用缓存的凭据」 | 〔官方摘要〕 |

### 2.2 Scry 怎么判断已登录（不读秘密）

不读钥匙串、不读 token 文件内容、不调 ACP `authenticate`（它会发起浏览器登录：T3 在 stdout 拦 `Open the following link to authenticate the ACP server:`，`antigravityAuthSupport.ts:26`〔T3〕）。

| 阶段 | 判据 | 结果 |
|---|---|---|
| `describe()` | 只看二进制与版本 | 有二进制 → `available: true`，health `unknown`，`lastError` 留空；登录未确认不写成 ready |
| 第一次需要会话时（读模型目录或发送） | 在 Scry 自有临时目录里 `initialize` → `session/new`；返回 ACP `auth_required`（-32000），或 1.5 CLI 无显示器时的 -32603 `No browser is available here`（`antigravityAuthSupport.ts:167-176`〔T3〕），或 stdout 出现上面那行登录提示 | 判「未登录」，进程立即按身份停止 |
| 缓存 | 结果按 `continuationKey` 缓存；用户点「刷新」或 key 变化才重测 | — |

未登录时的 envelope：`capabilityUnavailable(context, 'unsupported', 'Antigravity 未登录：在终端运行 agy 完成登录（或 agy acp --login），再回到 Scry 刷新')`。run 以 `AgentRuntimeError`（stage `capability`）失败，`error-classify.ts:13-14` 增加 agy 的提示文案。登录提示行**不进日志、不进 trace**（含一次性 `state`）。

未登录时 `session/new` 是否会自己弹浏览器〔未核实〕：§6.2 第 3 项必查。若会弹，启动环境加 `BROWSER` 指向一个立即失败的固定命令（不含秘密），并在文档写明。

### 2.3 各登录方式的行为

| 用户在 CLI 里配的方式 | Scry 的行为 |
|---|---|
| Google 账号（钥匙串） | 直接可用。macOS 后台服务由 launchd 在用户会话里拉起，能读登录钥匙串〔未核实〕；Linux `systemd --user` 下 Secret Service 可能未解锁，`agy` 报未登录 → 如实 unavailable，提示在桌面会话里先解锁或用 API key |
| 强制文件存储 | 只要用户自己的 shell 环境里设了该变量，Scry 原样传递（`AGY_` 前缀不清洗），否则 `agy` 读不到同一份登录 |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | **默认清洗**（§2.4），需用户显式放行 |
| ADC | `AGY_ADC_AUTH` 原样传；`GOOGLE_*` 默认清洗，需显式放行项目/区域变量 |

### 2.4 环境变量：默认清洗，显式放行

现状：`sanitizeProviderEnv` 对所有 Provider 删 `GOOGLE_`、`GCP_`（`src/main/provider-environment.ts:40`），允许经 `SCRY_PROVIDER_ENV_ALLOW=<provider>:<NAME>` 逐个放行（`provider-environment.ts:32-38`）。`GEMINI_` 目前没有规则，会原样传给全部 Provider。

决定（保守、显式）：

1. 新 ProviderId `antigravity`：删 `ANTHROPIC_`、`CLAUDE_`、`OPENAI_`、`CODEX_`、`QODER_`、`OPENCODE_`，以及 `GEMINI_API_KEY`、`GOOGLE_API_KEY`（后两者沿用全局 `GOOGLE_` 规则或新增精确名）。
2. 反向：其余五个 Provider 的前缀表加 `GEMINI_`、`ANTIGRAVITY_`、`AGY_`，不把 Google 凭据带给别的 Agent。
3. 用户要用 key/ADC：`SCRY_PROVIDER_ENV_ALLOW=antigravity:GEMINI_API_KEY,antigravity:GOOGLE_CLOUD_PROJECT`。未登录提示里，若清洗掉的名字里有这些（**只报名字，不读值**），附一句怎么放行。
4. Scry 自己不设置 `GEMINI_HOME`、`AGY_ACP_FORCE_FILE_STORAGE`、`--gemini-dir`：这些会换掉用户的登录与数据目录。T3 用私有 `GEMINI_HOME` 隔离（`antigravityAuthSupport.ts:201-235`〔T3〕），与决定 3 相反，不借鉴。

### 2.5 条款风险（必须让维护者知道）

搜索摘要显示：Google Antigravity FAQ 称用第三方工具经 Antigravity 登录访问服务违反条款，个人方案下不支持把 `agy` 包进第三方应用，建议第三方 Agent 改用 Gemini Enterprise 或 AI Studio API key；论坛有封号报告〔官方摘要〕〔社区〕。原文未读到。这与决定 1、3 直接相关，列为 §9 D1。

## 3. 能力矩阵

「同类」列给最接近的现有 Provider 做法。未核实的能力在真机通过前一律按 unavailable 处理，不先宣称。

| 能力 | agy 经 ACP | Scry 做法 | 同类 |
|---|---|---|---|
| 流式文本/思考 | `agent_message_chunk`、`agent_thought_chunk` | `text_delta`、`thinking` trace | Codex `item/agentMessage/delta` |
| 工具调用 | `tool_call` / `tool_call_update`（id、kind、status、content、locations） | 按 `toolCallId` 聚合成一次逻辑调用；`available + []` 仅在本轮确有 PromptResponse 时成立 | — |
| 审批 | `session/request_permission`，选项 `allow_once`/`allow_always`/`reject_once` | 转 `AgentQuestionRequest`；`allow_always` 只在有该选项时给，并显示 `_meta["agy.security.warning"]`（`acp/AntigravityProtocol.ts:54-102`〔T3〕） | Qoder `qoderCanUseTool` |
| 提问 | 走同一方法，`toolCallId` 以 `interaction_` 开头（`AntigravityProtocol.ts:49-52`〔T3〕） | 当提问处理；`full_access` 下也不自动回答。分类只靠该结构化字段，判不准就按审批展示，交给用户 | Qoder `AskUserQuestion` |
| 权限 `default` | 会话模式 `default`，按用户 `toolPermission`（默认 `request-review`）询问〔官方摘要〕 | 提供。用户全局设为 `always-proceed`/`proceed-in-sandbox` 时，Scry 只读该键，选项说明改成实际效果，见 §9 D3 | — |
| `auto_accept_edits` | CLI 拒绝 `auto_edit` 会话模式（`AntigravityAcpSupport.ts:186-193`〔T3〕） | **不提供**；收到即 `unsupportedPermissionMode` 报错（`run-controls.ts:58-64`） | OpenCode |
| `auto_review` | 无原生审查器（T3 文档：Antigravity 回落为询问） | **不提供** | OpenCode |
| `full_access` | CLI 拒绝 `yolo` 会话模式〔T3〕；交互 CLI 有 `--dangerously-skip-permissions`，`agy acp` 是否接受〔未核实〕 | 只在真机证实有**原生** always-proceed 入口时提供；否则不提供。Scry 端代答所有审批不算原生，见 §9 D2 | Qoder `bypassPermissions` |
| 计划模式 | 原生 `/plan`、`--mode=plan`〔官方摘要〕 | 不是 Scry 权限档；作为原生命令透传，不在 run control 里伪装 | — |
| 停止 | `session/cancel` 通知，PromptResponse `stopReason: cancelled` | 协作式取消 → 宽限期 → 按身份信号进程树；`cancelled` 响应才是终止证据 | Pi |
| 恢复 | `session/resume`（不重放）优先，否则 `session/load`（重放，T3 注释 `AntigravityAdapterV2.ts:243`） | 恢复后**显式重设**模型、思考档、权限模式；`load` 的重放更新丢弃，不进 trace | — |
| 原生分叉 | T3 不宣称（`provider-acp/src/server/adapter.ts:738`）〔T3〕 | 不提供 `forkSession`/`forkLastTurn`；仅当 `initialize` 广告 fork 能力且真机验证后再议 | — |
| 侧边会话 | — | 走 Scry 自己的可见历史副本 + `historicalContext`；需先实现输入回执 | Qoder |
| 模型 | `session/new` 的 `configOptions` 里 `id: "model"` 的 select | 读取账号实际可用列表；非 Gemini 模型（Claude、GPT）标「经 Antigravity 提供」，`AgentModelRef.providerId = 'antigravity'` | — |
| 思考档 | `category: "thought_level"` 的 select，只对当前模型报告（`AntigravityAcpSupport.ts:217-223`〔T3〕） | 只列该模型报告的档位；不跨模型推断 | Codex effort |
| MCP 注入 | `session/new.mcpServers`（HTTP/stdio，含 headers/env）走 stdin〔T3 用 HTTP〕 | 只注入 Scry 自有的 run 级服务（历史检索），不进 argv、不落文件，§5.3 | Claude 私有文件 |
| 原生 MCP 发现 | 读 `~/.gemini/config/mcp_config.json` 与 `<ws>/.agents/mcp_config.json`〔官方摘要〕 | 状态只读（`mcp: 'read'`，来源文件，非实时）；工作区文件过 trust gate，§5.4 | — |
| 子 Agent | 当普通工具报告（`start_subagent`/`invoke_subagent`），无子会话 id（`AntigravityProtocol.ts:483-503`〔T3〕） | 只读展示为工具调用；不设 `turnRole: subagent`（未观测到角色）；不能控制 | — |
| 附件/图片 | `promptCapabilities.image/audio/embeddedContext` | 图片按能力发 `image` 块；其他文件发路径文本；不支持就报错，不静默丢 | — |
| 用量 | PromptResponse `usage`，Gemini 口径：input 不含 cached、output 不含 thought；只覆盖主 Agent（`AntigravityAdapterV2.ts:287-289`；`provider-acp/src/server/adapter.ts:299-330`〔T3〕） | 主 Agent token `exact`；有子 Agent 时覆盖 `partial`；美元费用与配额 `unavailable`（配额要用 OAuth token 调接口，违反「不读秘密」，不做） | Pi 分作用域 |
| 历史读取（`sessionEvidence`） | 原生记录是 `conversations/<id>.db`（SQLite，protobuf 负载）与 `.meta`（`acp/AntigravitySessionFiles.ts:24-34`〔T3〕） | 首版不读：私有格式，版本漂移大 | — |
| 历史检索工具（`historyReader`） | 依赖 MCP 注入 | 真机证实 `mcpServers` 生效后才开 | Claude/Codex |
| 命令目录 | `available_commands_update` 只在会话里出现 | 显示最近一次所见并标观测时间，可能过期 | — |
| Skill | `.agents/skills`、`.gemini/skills`、`.agent/skills`；用户级 `~/.gemini/config/skills`、`~/.gemini/antigravity-cli/skills`（T3 用户文档） | 只读列出 | Qoder |
| 终端录制 | — | 范围外（决定 2）；见 §8 | — |
| run controls | 模型/思考/权限 | `runControls` facet；需要一次 `session/new`，在 Scry 临时目录里做 | Qoder catalog |
| 远程设备 | — | 经已有 provider discovery 自动出现；远程权限上限 `SCRY_REMOTE_PERMISSION_MODE` 照常生效；未登录只能在宿主机修 | — |
| 输入回执 | PromptResponse 返回即确认原生会话收到；ACP 无 turn id（`adapter.ts:744`〔T3〕） | 新回执来源 `antigravity_prompt_response`；`providerTurnId` 不设，依赖它的功能 unavailable | — |
| 压缩 | ACP 下 `/compact` 当普通输入（`AntigravityAdapterV2.ts:283`〔T3〕） | 不提供手动压缩 | — |

工作区副作用：会话开始时 `agy` 在工作区建空的 `.gemini/skills`、`.agents/skills`（T3 用户文档）〔未核实〕。Scry 不替它清理，在 Provider 说明里写明。
