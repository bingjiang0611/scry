# P7 · Antigravity Provider：集成点与安全（只设计）

接 [P7-antigravity-provider](P7-antigravity-provider.md)（§0–§3），章节编号连续。标记〔T3〕〔官方摘要〕〔社区〕〔未核实〕含义见那篇 §0.2。

## 4. 集成点

### 4.1 运行位置：daemon 一等，进程内不单独做

- App 与 daemon 用同一个 `createProviderRuntime`（`src/main/index.ts:111`、`src/daemon/host-process.ts:96`），都经 `createBuiltInProviderAdapters`（`src/main/providers/index.ts:21-28`）。所以 adapter 只写一份，**不改 `src/daemon/host-process.ts`**（另一执行方在改）。
- 决定：daemon 模式是唯一做真机验收的路径。进程内路径不做单独验收：B4-S 已定 S1 默认打开与 S3 删除一起做（[P3-b4s-plan](P3-b4s-plan.md) 末节「一步到位」）。进程内仍会注册这个 adapter（同一注册表），单测覆盖即可，不为它加专门代码。
- 若 P7 先于 B4-S 切换合入：`SCRY_HOST_DAEMON` 关闭时 Antigravity 照样可用（同一 adapter），但在 Provider 说明里标「仅在后台服务模式下验收」。

### 4.2 文件清单

新文件（每个 < 20,000 字节）：

| 文件 | 内容 |
|---|---|
| `src/main/providers/acp-client.ts` | 最小 JSON-RPC 2.0 over stdio：按行分帧、单行上限、非 JSON 行旁路（登录提示行即在此识别）、请求超时、未知方法回 `-32601` |
| `src/main/providers/antigravity.ts` | `createAntigravityAdapter(homeDir)`：`describe`、`run`、facet 组装 |
| `antigravity-launch.ts` | 找二进制、版本、环境、`spawn`（detached）、进程身份、停止 |
| `antigravity-run.ts` | 一轮的状态机：`initialize` → `session/new|resume|load` → 设置模型/思考/模式 → `session/prompt` → 收口 |
| `antigravity-events.ts` | `session/update` → `TraceEvent`；`recordNative` 写原生流 |
| `antigravity-permissions.ts` | 审批/提问映射、权限档目录、拒绝不支持的档 |
| `antigravity-catalog.ts` | 模型、思考档、命令、Skill；登录探测与缓存 |
| `antigravity-config-trust.ts` | 工作区可执行配置的指纹与 fail-closed 检查（§5.4） |
| `antigravity-usage.ts` | PromptResponse `usage` → Scry 用量（Gemini 口径，§3） |
| `fixtures/fake-agy-acp.mjs` + `antigravity-*.test.ts` | §6.1 |

改动的现有文件：

| 文件 | 改什么 |
|---|---|
| `src/shared/provider.ts:5` | `ProviderId` 加 `'antigravity'`；`MCP_LIVE_CHECK_CANCEL`（`:16`）、`PROVIDER_LABELS`/`PROVIDER_TRANSPORTS`（`:134-146`）补条目，transport 写 `ACP (stdio)` |
| `src/shared/runtime-types.ts:14` | `RuntimeProvider` 加 `'antigravity_acp'` |
| `src/shared/runtime-provider.ts:7-46` | agentId ↔ ProviderId ↔ RuntimeProvider 映射 |
| `src/shared/runtime-input.ts:13`、`turn-record.ts:265`、`turn-intervention-validation.ts:27`、`provider-compatibility.ts:157` | 各处 Provider 白名单 |
| `src/main/providers/index.ts:21-28` | 注册 adapter |
| `src/main/providers/registry.ts:256` | `parseDisabledProviders` 认识 `antigravity` |
| `src/main/providers/types.ts:53-60` | 回执来源加 `antigravity_prompt_response` |
| `src/main/claude-locate.ts:373-380`、`483-490` | `KNOWN_AGENTS`、`resolveRuntimeCliBin('antigravity')`、`SCRY_AGY_PATH` |
| `src/main/provider-environment.ts:41-47` | 前缀表（§2.4） |
| `src/main/mcp-config.ts:112-138` | `providerMcpConfigPaths('antigravity')`：用户级 `~/.gemini/config/mcp_config.json`、工作区 `.agents/mcp_config.json`；解析 `mcpServers` |
| `src/main/bootstrap/trust.ts:27-100` | 新增 `resolveAntigravityConfigTrust`，与 Codex Hook、OpenCode plugin 并列 |
| `src/main/provider-compatibility-manifest.ts:53` | 加 `>=1.5.1 experimental` |
| `src/main/error-classify.ts:13` | agy 未登录/配额提示 |
| `src/host-runtime/host-runtime.ts:111` | `listCommands` 的 Provider 白名单 |
| `src/main/remote/desktop-host-reader.ts:20` | `PROVIDERS` |
| `src/daemon/login-start/policy-env.ts:25` | `KNOWN_PROVIDERS`，否则 `SCRY_DISABLED_PROVIDERS=antigravity` 写服务文件时被拒 |
| `src/main/app-store.ts:45-46`、`conversation-schema.ts:33`、`conversation-side-chat-schema.ts:12`、`transcript-archive.ts:109,731-732`、`span-ledger.ts:348`、`trace-turn-progress.ts:42-43`、`llm-performance-history.ts:13`、`background-service-status.ts:77` | 持久化与投影里的 Provider 枚举 |
| `src/renderer/hooks/integration-model.ts:15`、`provider-brand-marks.ts`、`AskUserQuestionDialog.tsx`、`render-tests/capabilities.tsx:34` | 显示名、图标、能力展示（图标用中性字母标，不用 Google 商标图形，§9 D7） |
| `src/main/providers/smoke.ts` | smoke 夹具认识新 id（只在 smoke 开关下） |
| `GLOSSARY.md` | Provider 条目举例加 Antigravity（实现时同变更） |

`src/core/turn-recorder/*`、`src/cli/*` 里的 Provider 枚举**不改**：Recorder 不在范围内（决定 2）。若类型检查要求穷举，用显式「不支持」分支，不加录制逻辑。

### 4.3 每个 run 的进程模型

- 一个 Scry run 一个 `agy acp` 进程：spawn → `initialize` → 会话 → `prompt` → 收口 → 关 stdin、按身份结束。`forceKillScope: 'run_scoped'`（`types.ts:79-84`）。
- 不做常驻池（`catalogWarmPool` 不设）。原因：没有测过启动成本；T3 注释说旧托管运行时每次启动解包约 1 GB，探活不得 spawn（`Drivers/AntigravityDriver.ts:399-401`〔T3〕），原生 CLI 是否仍如此〔未核实〕。真机测得启动 < 1 s 再议池化。
- 社区文档提到 `agy acp --process-per-session`〔社区〕，不依赖。
- 目录读取（模型/思考/登录探测）在 Scry 自有的 0700 临时目录里开一次短会话，不在用户项目里建 `.agents/skills` 等目录。该短会话会在用户的 agy 数据目录留下一条会话记录；Scry **不删除**（删除是对 Provider 数据的写操作），见 §9 D5。
- 卡住保护：prompt 期间若既无更新、也无未决的审批/工具，超时 15 分钟判失败（T3 同值，`AntigravityAdapterV2.ts:286`〔T3〕），原因写明，不当成成功。

### 4.4 远程设备

- 远程 provider discovery（`src/main/remote/provider-discovery.ts:29-97`）按 descriptor 与 controls 工作，注册后自动出现；不新开远程 op。
- 远程权限上限照常裁剪权限档；未登录 envelope 的原因文本原样给远程，修复动作只能在宿主机。
- 远程设备看到的模型名同样带「经 Antigravity 提供」后缀。

## 5. 安全

### 5.1 进程身份与停止

- spawn 用 `detached: process.platform !== 'win32'`，立即 `captureProcessIdentity(child.pid)`，与 Qoder 一致（`src/main/providers/qoder-launch.ts:204-219`、`src/main/process-diagnostics.ts:368`）。
- 停止三段，状态如实上报（`AgentStopPhase`，`runtime-types.ts:112-130`）：
  1. `session/cancel` → `interrupt_requested`；发送失败 → `interrupt_request_failed`。
  2. 宽限期满，`signalProcessTreeWithIdentity` 发 `SIGTERM`（`process-diagnostics.ts:299`，经 `qoder-launch.ts:87-103` 同款封装）→ `force_kill_requested`。
  3. 再满 → `SIGKILL`；仍未 settle → `provider_unsettled`。
- 只有 PromptResponse `stopReason: cancelled` 或进程退出且 stdout 关闭才算 settle。身份采不到、核对不上就不发信号，fail closed；绝不 `pkill agy`。
- `agy` 跑的终端命令、stdio MCP 子进程在同一进程组里，随组停止〔未核实：agy 是否把子进程放进别的组，§6.2 第 9 项〕。

### 5.2 环境清洗

- 启动环境 = `runtimeCliEnv(undefined, { providerId: 'antigravity' })`（`claude-locate.ts:492-501` → `buildRuntimeCliEnv` → `sanitizeProviderEnv`），规则见 §2.4。
- `sanitizeNestedAgentEnv`（`provider-environment.ts:3-18`）照样去掉 Scry 自己与嵌套 Agent 的变量。
- 不加 `PYTHONUNBUFFERED`、`ELECTRON_RUN_AS_NODE`、私有 `TMPDIR` 这类 T3 托管运行时专用的变量（`antigravityAuthSupport.ts:224-235`〔T3〕）。

### 5.3 秘密不进 argv 与日志

- argv 固定为 `['acp']`，不带任何配置值、路径之外的参数。
- Scry 注入的 MCP（目前只有历史检索：`url` + bearer `token`，`src/main/conversation-history-reader.ts:14-18`）放在 `session/new` / `session/resume` 请求体的 `mcpServers[].headers` 里，走 stdin 管道：不进 argv，也不落盘，因此**不需要** `private-mcp-config.ts` 的私有文件，也不需要 `codex-stdio-env.ts` 的启动脚本。`*-mcp-argv.test.ts` 同款参数记录器断言 argv 不含 token（`src/main/providers/argv-recorder.fixture.ts`）。
- 若真机发现 agy 忽略 `mcpServers`：不退回 argv，也不往用户的 `mcp_config.json` 里写；`historyReader` 保持关闭并记已知问题。
- 原生流日志（`recordNative`）与 stderr 尾巴先过 `maskSecrets`（`src/shared/trace.ts:481`）；登录提示行（含 OAuth `state`）整行丢弃，只记「检测到登录提示」。
- 用户经 `SCRY_PROVIDER_ENV_ALLOW` 放行的 key 只在子进程环境里；诊断只报变量名。

### 5.4 仓库控制的配置与 trust gate（fail closed）

Scry 不能像 Qoder 那样用 `strictMcpConfig` 关掉原生发现（`qoder-launch.ts:197-199`）：`agy acp` 没有已知的同类开关〔未核实〕。所以门禁放在启动前：

| 工作区文件 | 风险 | 处理 |
|---|---|---|
| `.agents/hooks.json` | 可执行 Hook，agy 自己执行〔官方摘要〕 | 指纹门禁 |
| `.agents/mcp_config.json` | 可执行 MCP 服务器 | 进 `providerMcpConfigPaths`，走现有 MCP 执行信任（`src/main/mcp-execution-trust.ts`） |
| 工作区 plugin（含 hooks） | 可执行〔官方摘要：plugin 可带 hooks〕，路径〔未核实〕 | 真机确认路径后纳入；确认前若发现疑似目录则拒绝启动 |
| `.agents/skills`、`.gemini/skills`、`.agent/skills` | 文本指令，可引用脚本，但由 Agent 经已审批的工具执行 | 只列出，不进门禁（与 Qoder Skill 同口径） |
| `AGENTS.md`、`GEMINI.md` 等规则文本 | 提示词注入，不是执行 | 不门禁；Scry 不是沙箱 |

门禁规则：

1. 指纹 = canonical cwd + 每个文件的相对路径、大小、sha256，按固定顺序；任何符号链接、越出工作区、超大小、解析失败 → **拒绝启动**，原因写明文件。
2. 按 2026-09-21 政策自动授权：首次与指纹变化时重验，记 `source: auto`，不弹窗、不显示成用户批准（AGENTS「已确认的权限策略」）。
3. 每次启动（run、resume、目录读取的短会话）都重算；目录读取的短会话在 Scry 临时目录里跑，不读用户项目，所以不受项目配置影响。
4. 校验与 agy 实际读取之间有时间差，与 Codex Hook 相同的残余风险，照实写在 Provider 说明里。
5. 用户级 `~/.gemini/config/{hooks,mcp_config}.json` 是用户自己的配置，与其他 Provider 的用户级配置同口径，不门禁，只在 MCP 面板展示。
6. 未知的新配置面（新版本新增）无法门禁：兼容性清单只把实测版本标 `supported`，其余显示建议，不阻断。

### 5.5 `full_access` 文案

若真机证实有原生入口并提供（§9 D2），选项说明用 Provider 专用文案：

> 让 Antigravity 不经询问执行工具（等同 agy 的 always-proceed）。这是本机用户权限，不是沙箱；Antigravity 自己的 deny 规则与终端沙箱设置仍然生效；提问仍要你回答。仓库里的 Hook 与 MCP 照样要通过指纹检查。

`default` 的说明在用户全局 `toolPermission` 不是 `request-review`/`strict` 时改为如实描述（§9 D3）。只读这一个键，不读其他设置。
