# P7 · Antigravity CLI（`agy`）Provider（设计定稿）

状态：A0 真机探测与独立评审后定稿（不含产品实现；4 项受 `MEASURING` 锁暂停的深探待补，见 [W7.md](handoff/reports/W7.md)）。本文 §0–§3：已定决策、来源、传输、登录、能力矩阵。§4–§5 集成点与安全见 [P7-antigravity-integration](P7-antigravity-integration.md)；§6–§9 测试、拆分、Recorder 备注与待决定见 [P7-antigravity-plan](P7-antigravity-plan.md)。

## 0. 已定决策与来源

### 0.1 维护者已定决策（2026-11-19）

1. 允许真实 Antigravity run 与费用（记在维护者 Google 账号）。
2. 范围：Scry 驱动 `agy` 会话，不做 scry CLI / Recorder 录制终端里的 `agy`（§8 只记线索）。
3. 登录对齐 Codex/Qoder：Scry 不实现登录、不弹浏览器、不发起登录，复用 CLI 已有登录态；维护者已知悉条款风险并决定使用，文案只提示「Google 对第三方客户端使用 Antigravity 登录可能有限制，请自行确认方案条款」，不下违规结论。
4. 权限：凡 `agy` 原生支持的模式都提供；无原生对应的不显示，**不伪造、不静默降档、不由 Scry 代答冒充完全访问**。
5. 已采纳评审推荐：未验证版本只在实验开关（`SCRY_EXPERIMENTAL_PROVIDERS=antigravity`）下可用；工作区设置含权限键时拒绝启动并说明；一 run 一进程下后台子 Agent 与 `/goal` 随进程结束被终止须写明；缺失费用记未知而非 0；Windows 明确不支持；D2–D8 按调整后方案定稿（见 plan §9.1）。

### 0.2 来源与核实程度

| 标记 | 含义 |
|---|---|
| 〔A0 实测〕 | 2026-11-20 在 macOS 27.0（arm64）对本机 `agy 1.5.12` 实测，原始证据存 `~/.local/state/scry-handoff-evidence/W7/` |
| 〔内置文档〕 | 读自本机 `agy 1.5.12` 自带 `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/` |
| 〔T3〕 | 读自 T3 Code 源码（`8cf97b5f`），仅在 A0 未覆写处作参考 |
| 〔待补测〕 | 因并发 `MEASURING` 锁暂停的 4 项深探（见 `W7.md`），A1 写代码前补跑确认 |

没有标记的句子说的是 Scry 现状，带 `file:line`。

## 1. 传输与版本

### 1.1 选 ACP over stdio

| 方式 | 说明 | 结论 |
|---|---|---|
| `agy acp`（JSON-RPC 2.0 over stdio） | 官方编辑器接口；支持流式 `session/update`、结构化审批、`session/cancel`、`session/resume`/`load`、`mcpServers`〔A0 实测〕 | **采用** |
| `agy -p`/`--print` | 无结构化审批交互 | 不用 |
| 驱动 TUI（伪终端） | 解析屏幕文本，证据不可信 | 不用 |

ACP 开放协议但本期**只为 agy 实现**（plan §9.1 D6）。

### 1.2 协议版本与最低 CLI 版本（关闭 B1）

- **协议握手〔A0 实测 `02-proto.json`〕**：向 `agy 1.5.12` 发送 `protocolVersion: 1` 与 `2`，服务端均返回 `protocolVersion: 1`、`agentInfo: { name: "Antigravity ACP Server", version: "1.5.12" }`、`agentCapabilities`（`loadSession: true`、`promptCapabilities: { image: true, audio: false, embeddedContext: true }`、`sessionCapabilities: { resume, close, load, list, additionalDirectories }` —— **无 `fork`**、`auth.logout`、`_meta.antigravity.tier`）以及 4 个 `authMethods`（`oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform`）。
- **判定规则**：握手发 `protocolVersion: 1`，按响应形状验证（`protocolVersion` 为正整数、`agentInfo` 存在、`loadSession === true || sessionCapabilities?.resume !== undefined`），**不写死 `=== 1`**；版本下限只看 `agy --version`，不用 `agentInfo.version`。
- **能力宣告**：`clientCapabilities` 显式发 `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`（防写能力把 diff 编辑降成整文件写〔T3〕）。
- **最低与支持版本**：Scry 固定报 `clientInfo = { name: "scry", version }`（不冒充 Zed）。最低版本下限 `>= 1.5.1`（低于报 unavailable）；兼容性清单（`src/main/provider-compatibility-manifest.ts`）参照 Qoder/Pi 把实测版本线 `>=1.5.12 <1.6.0` 标 `supported`（A9 真机验收前标 `experimental`），高于实测线与低于 `1.5.12` 的未验证版本标 `unsupported`，**仅在实验开关打开时允许启动**（防未知配置面 fail open，关闭 B5 版本项）。

### 1.3 找到并校验二进制

| 步骤 | 做法 | 参照 |
|---|---|---|
| 覆盖路径 | `SCRY_AGY_PATH`，存在才用 | `SCRY_QODERCLI_PATH`（`claude-locate.ts:382-385`） |
| PATH | `which('agy')`，用 login shell PATH + 常见目录（如 `~/.local/bin`） | `claude-locate.ts:252-288` |
| 快速探测 | `KNOWN_AGENTS` 加 `{ id: 'antigravity', name: 'Antigravity', bin: 'agy' }`，受 `SCRY_EXPERIMENTAL_PROVIDERS` 控制 | `claude-locate.ts:373-380` |
| 版本 | `agy --version`，5 s 超时（实测 `1.5.12`） | `claude-locate.ts:317-348` |
| 身份 | `realpath` 后哈希进 `continuationKey` 与进程身份 | `qoder-launch.ts:139-143` |

不下载、不安装、不升级 `agy`。启动耗时实测：冷启动 `969 ms`、热启动 `44 ms`、空闲关 stdin 退出 `1–2 ms`〔A0 实测 `02-proto.json`〕。

## 2. 登录状态与环境变量

### 2.1 `agy 1.5.12` 凭据实际存放〔A0 实测 `01b/01c/11` + 日志〕

实测发现 `agy 1.5.12` 使用双模式存储（`composite_token_storage.go`）：

| 运行环境 | 凭据存放 | 实测行为 |
|---|---|---|
| 正常 macOS 桌面 / Finder / `launchd`（无 `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`） | **macOS 钥匙串**（`svce="gemini"`、`acct="antigravity"`） | 首次在非 SSH 环境刷新 token 时，`agy` 会把旧文件 `~/.gemini/antigravity-cli/antigravity-oauth-token` 自动迁入钥匙串并删原文件〔A0 实测 `acp-server-20261120_010746` 日志〕 |
| SSH 会话（含 `SSH_*`）或 `AGY_ACP_FORCE_FILE_STORAGE=1` | 文件 `~/.gemini/antigravity-cli/antigravity-oauth-token`（0600） | `composite_token_storage.go:176` 明确切到文件存储且**不读钥匙串** |
| Gemini API key / ADC | `GEMINI_API_KEY` / `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`（或 `settings.json` 的 `gcp.*`） | 默认清洗，需用户经 `SCRY_PROVIDER_ENV_ALLOW` 显式放行 |

- **macOS `launchd` 登录时启动实测〔A0 实测 `11-launchd.json`〕**：仅设 `HOME`、`PATH`、`BROWSER` 的最小 LaunchAgent（无任何终端环境变量）下，`agy acp` 成功完成 `initialize` + `session/new` 并返回全部 11 个模型，说明 `launchd` GUI 域可直接读取钥匙串登录态。
- **Linux `systemd --user`**：Secret Service 未解锁时 `agy` 报未登录 → 如实 unavailable，提示在桌面会话解锁或改用显式放行的 API key。

### 2.2 登录探测与 `authenticate` 决策（关闭 B2）

- **A0 实测结果〔`03-auth.json`〕**：
  1. 已登录、**不调 `authenticate` 直接 `session/new`**：成功（`2,702 ms`），返回 `sessionId`、`models`、`modes`、`configOptions`、`_meta.antigravity.tier`，零浏览器调用。
  2. 未登录（隔离空 `--gemini-dir` + `AGY_ACP_FORCE_FILE_STORAGE=1`）、直接 `session/new`：`58 ms` 返回 JSON-RPC 错误 **`-32000 Authentication required`**，零浏览器调用。
  3. 已登录调 `authenticate("oauth-personal")`：静默返回 `{ _meta: { antigravity: { tier } } }`（`2,504 ms`）；未登录调 `authenticate("oauth-personal")` 返回 `-32603 No browser is available here ... Run agy acp --login ...`；调 `gemini-api-key` 缺环境变量报 `-32602`；调 `agent-platform` 缺项目/区域报 `-32602`。
- **定稿**：Scry **不调用 `authenticate`**，永远走 `initialize` → `session/new`（`GEMINI_API_KEY` 不调 `authenticate` 能否直接 `session/new` 属〔待补测〕；若需调用，仅在用户显式放行 `GEMINI_API_KEY` 时只调 `authenticate("gemini-api-key")`，绝不对 OAuth 调 `authenticate`）。
- **防弹浏览器**：启动 `agy acp` 固定把 `BROWSER` 设为**立即退出码 `0`** 的空命令（非 0 会回退打开真实浏览器〔T3〕）。
- **各阶段判据**：
  - `describe()`：仅看二进制与版本，登录未核实前 health 标 `unknown`。
  - 首次读目录或发送：在 0700 临时目录跑 `initialize` → `session/new`，结果按 `continuationKey` 缓存；收到 `-32000` / `-32603 No browser…` / stdout 登录提示行 → 判未登录并按身份停止进程，返回 `capabilityUnavailable(context, 'unsupported', 'Antigravity 未登录：在终端运行 agy 完成登录（或 agy acp --login），再回到 Scry 刷新')`。
  - 登录提示行（含 OAuth `state`/`code`）整行丢弃，不进日志、不进 trace。

### 2.3 环境变量：默认清洗，精确名单放行（关闭 B3）

- **Login shell 捕获（`claude-locate.ts`）**：先拆出环境捕获子模块解决 20 KB 上限；不整段放行 `AGY_*`，仅在捕获名单保留非凭据运行变量，凭据与身份选择变量由用户显式配置后经同一名单读取。
- **启动 `agy acp` 的清洗规则（`provider-environment.ts`）**：
  1. 跨 Provider 清洗：删除 `ANTHROPIC_`、`CLAUDE_`、`OPENAI_`、`CODEX_`、`QODER_`、`OPENCODE_`、`AWS_`、`AZURE_`、`GOOGLE_`、`GCP_`。
  2. `antigravity` 自身凭据与身份选择变量**默认全部清洗**，仅经 `SCRY_PROVIDER_ENV_ALLOW=antigravity:<NAME>` 逐个放行：
     `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`GCLOUD_PROJECT`、`CLOUDSDK_CORE_PROJECT`、`AGY_ADC_AUTH`、`AGY_ACP_FORCE_FILE_STORAGE`、`AGY_ACP_ENABLE_OAUTH`、`AGY_ACP_CCPA_PROJECT`、`GEMINI_HOME`、`ANTIGRAVITY_HARNESS_PATH`。
  3. **固定剥离 `SSH_CLIENT`、`SSH_CONNECTION`、`SSH_TTY`**（除非用户显式放行 `AGY_ACP_FORCE_FILE_STORAGE`），防止守护进程从 SSH 启动时触发 `composite_token_storage.go` 忽略钥匙串（见 plan §9.2 D10）。
  4. **固定设置 `BROWSER`** 为退出 0 的无操作脚本（覆盖用户环境里的 `BROWSER`）。
  5. **反向清洗其他 5 个 Provider**：`claude`/`codex`/`qoder`/`opencode`/`pi` 的前缀表全部加入 `GEMINI_`、`AGY_`、`ANTIGRAVITY_`；`opencode`/`pi` 用户若从终端用 Gemini 模型，改由 `SCRY_PROVIDER_ENV_ALLOW=pi:GEMINI_API_KEY` 放行，写进变更说明并加单测。
  6. 未登录提示若检测到上述被清洗的变量名（**只报名字，不读值**），附带放行提示。

## 3. 能力矩阵

未在真机通过的项保持 unavailable，不先宣称。

| 能力 | `agy 1.5.12` 经 ACP | Scry 做法 | 同类 |
|---|---|---|---|
| 流式文本/思考 | `agent_message_chunk`、`agent_thought_chunk` | `text_delta`、`thinking` trace | Codex |
| 工具调用 | `tool_call` / `tool_call_update`（id、name、kind、status、locations、rawInput） | 按 `toolCallId` 聚合；未先见 `tool_call` 的 `request_permission` 亦建出逻辑调用；`available + []` 仅在确有 PromptResponse 时成立 | — |
| 审批 | `session/request_permission`（**实测 `id` 为字符串**，如 `"1"`；`options` 含 `optionId`/`name`/`kind`）〔A0 实测 `04-modes.json`〕 | 按 `agy` 给出的全部选项原样渲染（`name` + `kind`），同 `kind` 多选项不截断；展示 `_meta["agy.security.warning"]` | Qoder |
| 提问 | 同一方法，`toolCallId` 以 `interaction_` 开头为约定（非身份边界） | 按提问展示；`full_access` 也不自动回答；判不准一律当审批交用户 | Qoder |
| 权限 `default` | 会话模式 `default`（`session/set_mode` 实测接受）〔A0 实测〕 | 提供。读 `~/.gemini/antigravity-cli/settings.json` 检查是否把有效权限抬高（`permissions`/`toolPermission`）；有效权限高于所选或远程上限时拒绝启动，turn record 记有效档位（D3） | — |
| `auto_accept_edits` | **原生支持**：会话模式 `accept-edits`（"Approve file edits in the workspace without asking"，`set_mode` 实测返回 `{}`）〔A0 实测 `04-modes.json`〕 | **提供**，映射为 `session/set_mode("accept-edits")`（各工具是否发审批待补测 `modes` 深探） | Codex |
| `auto_review` | 原生模式 `auto`（"Approve edits and safe commands; ask before irreversible actions"，`set_mode` 实测返回 `{}`）〔A0 实测〕 | 是否映射到 `auto_review` 交维护者拍板（见 plan §9.2 D9）；未定前不伪装 | OpenCode |
| `full_access` | **原生支持**：`agy acp --dangerously-skip-permissions`（实测 `permissionRequestsCount: 0` 直接执行命令）〔A0 实测 `04-modes.json`〕 | **提供**（一 run 一进程下以启动参数传入）；deny 规则仍生效、提问仍由用户回答，见 integration §5.5 | Qoder |
| 计划模式 | 原生会话模式 `plan` / `/plan`〔A0 实测〕 | 作为原生命令/能力说明，不在权限档里伪装 | — |
| 停止 | `session/cancel` 通知，PromptResponse `stopReason: "cancelled"`（实测 5–15 ms 收口）〔A0 实测 `08-cancel.json`〕 | 由 `RunStopLifecycle` 驱动：`interrupt()`（先取消未决审批 + `session/cancel`）→ `forceKill()`（按身份 SIGTERM→SIGKILL 含独立进程组后代），见 integration §5.1 | Pi |
| 恢复 | `session/resume`（实测 2.2 s，**零重放**，准确回忆上下文）优先；`session/load`（1.9 s，重放历史）〔A0 实测 `07-lifecycle.json`〕 | 优先 `resume`；降级 `load` 时丢弃重放通知不进 trace；恢复后显式重设模型、思考档、模式 | — |
| 原生分叉 | `initialize.sessionCapabilities` **不含 `fork`**〔A0 实测 `02-proto.json`〕 | 不提供 `forkSession`/`forkLastTurn` | — |
| 侧边会话 | — | 走 Scry 可见历史副本 + `historicalContext`（A8，依赖输入回执） | Qoder |
| 模型与思考档 | `session/new.configOptions`：`model`（11 个，含 Gemini/Claude/GPT）、`thought_level`（随模型动态变化，如 `neon` 有 `xhigh`、`carbon` 无 `xhigh`）；切模型**不改** `settings.json`〔A0 实测 `09-usage.json`〕 | 非 Gemini 模型标「经 Antigravity 提供」；`thought_level` 只列当前模型报告的档位，不跨模型推断 | Codex |
| MCP 注入 | `session/new.mcpServers`（Streamable HTTP + `headers`）**实测完全生效**，argv 无 token，**但 token 会落入 `conversations/<id>.db`**〔A0 实测 `06-mcp.json`〕 | 仅注入 run 级历史检索，token 每轮随机、轮末即撤销，套 loopback `NO_PROXY`，见 integration §5.3 | Claude |
| 原生 MCP 发现 | 实测自动执行 `<ws>/.agents/`、`<ws>/.agent/`、`<parent>/.agents/` 与 `~/.gemini/config/mcp_config.json`〔A0 实测 `05-paths.json`〕 | 状态只读（`mcp: 'read'`）；全部工作区与上级路径及用户级配置进指纹门禁，见 integration §5.4 | — |
| 子 Agent | 视作工具调用，无独立子会话 id〔T3〕（工具名与用量表现〔待补测〕） | 只读展示为工具调用，不设 `turnRole: subagent`；一 run 一进程下随进程结束被终止 | — |
| 附件/图片 | `promptCapabilities: { image: true, audio: false, embeddedContext: true }`〔A0 实测〕 | 图片发 `image` 块；音频不支持直接报错；其他文件发路径文本，不静默丢 | — |
| 用量与费用 | **实测口径**：`totalTokens === inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens`，**`thoughtTokens` 已含在 `outputTokens` 内**（不重复加）；另发 `usage_update { used, size }`；**不回报实际应答模型**；无费用字段〔A0 实测 `04/06/07/08/09`〕 | `format-usage.ts` 口径为 `separate`；`reasoningTokens = thoughtTokens` 不抬高 total；`modelStatus: 'unobserved'` 带 `modelOmissionReason`；未证实无子 Agent 或取消/失败轮次标 `partial`；费用标 `unavailable`（`null`，修复 `billing-ledger.ts` 与 `usage-ledger-repair.ts` 绝不记 0） | Pi |
| 历史读取（`sessionEvidence`） | `conversations/<id>.db`（SQLite + protobuf） | 首版不读 | — |
| 命令 / Skill | `available_commands_update`；工作区 `{.agents,.agent,_agents,_agent}/skills` 与 `~/.gemini/config/skills`〔内置文档〕 | 命令标观测时间；Skill 只读列出 | Qoder |
| 远程设备 | 经 provider discovery 自动暴露 | 远程权限上限照常裁剪；未登录只能在宿主机修复 | — |
| 输入回执 / 压缩 | PromptResponse 确认收到（无 turn id）；`/compact` 为普通输入 | 回执来源 `antigravity_prompt_response`；不提供手动压缩 | — |

工作区副作用：实测 `agy acp 1.5.12` 启动会话**不会**自动在工作区新建 `.gemini/skills` 或 `.agents/skills`〔A0 实测 `05-paths.json`〕。
