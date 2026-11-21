# P7 · Antigravity Provider：集成点与安全（设计定稿）

接 [P7-antigravity-provider](P7-antigravity-provider.md)（§0–§3），章节编号连续。标记含义见 provider 篇 §0.2。

## 4. 集成点

### 4.1 运行位置：daemon 一等，进程内不单独做

- App 与 daemon 共用 `createProviderRuntime`（`src/main/index.ts:111`、`src/daemon/host-process.ts:96`）与 `createBuiltInProviderAdapters`（`src/main/providers/index.ts:21-28`）。adapter 只写一份，**不改 `src/daemon/host-process.ts`**。
- daemon 模式是唯一做真机验收的路径；进程内沿用同一注册表并由单测覆盖，不加专门代码。Windows 明确不支持（`describe()` 报 `unsupported_platform`）。
- 权限开关 `SCRY_EXPERIMENTAL_PROVIDERS`（当前不存在，需新建）：逗号分隔的实验 Provider 名单；未含 `antigravity` 时，adapter 注册、`KNOWN_AGENTS` 探测、远程 `provider-discovery` 均隐藏它；同时加入 `LOGIN_START_POLICY_ENV_KEYS`（`src/daemon/login-start/policy-env.ts:13-20`），使登录时启动服务文件同步该开关。

### 4.2 文件清单与 20 KB 预拆清单

#### 新文件（每个严格 < 20,000 字节）

| 文件 | 职责 |
|---|---|
| `src/main/providers/acp-client.ts` | 最小 JSON-RPC 2.0 over stdio：按行分帧（单行上限 **16 MiB**）、字符串/数字 `id` 兼容、非 JSON 行只计数不落日志（识别登录提示并丢弃）、请求超时、未知方法回 `-32601` |
| `src/main/providers/antigravity.ts` | `createAntigravityAdapter(homeDir)`：`describe`、`run`、facet 组装 |
| `src/main/providers/antigravity-launch.ts` | 找二进制、版本、环境清洗、spawn（detached + `BROWSER` 退出 0 + 去 `SSH_*`）、身份、停止与后代进程组清理 |
| `src/main/providers/antigravity-run.ts` | 一轮状态机：trust 检查 → `initialize` → `session/new\|resume\|load`（仅当显式放行 `GEMINI_API_KEY`/ADC 且遇 `-32000` 时调对应非浏览器 `authenticate`）→ 设模型/思考/模式 → `session/prompt` → 关 stdin 自然退出 |
| `src/main/providers/antigravity-events.ts` | `session/update`（含 `available_commands_update`、`session_info_update`、`usage_update`、`tool_call`/`tool_call_update`）→ `TraceEvent`；`recordNative` 原样记录原生流（不经 `maskSecrets`） |
| `src/main/providers/antigravity-permissions.ts` | 审批/提问映射（原样保留全部 `options`）、权限档目录、用户全局设置有效档位核对 |
| `src/main/providers/antigravity-catalog.ts` | 模型/思考/命令/Skill 读取、登录探测、按 `continuationKey` 缓存与同 profile 互斥 |
| `src/main/providers/antigravity-config-trust.ts` | 工作区与上级目录配置面指纹门禁（§5.4）及独立 grant 存储 |
| `src/main/providers/antigravity-usage.ts` | PromptResponse `usage` → Scry 用量（`separate` 口径、`thoughtTokens` 不重复加、`modelStatus: 'unobserved'`、缺失费用 `null`） |
| `src/main/providers/fixtures/fake-agy-acp.mjs` + `antigravity-*.test.ts` | 假 ACP Agent 与单测（plan §6.1） |

#### 改动的现有文件（含评审补全遗漏）

| 文件 | 改动 |
|---|---|
| `src/shared/provider.ts`、`runtime-types.ts`、`runtime-provider.ts` | `ProviderId` 加 `'antigravity'`、`RuntimeProvider` 加 `'antigravity_acp'`、`PROVIDER_LABELS`/`PROVIDER_TRANSPORTS`（`ACP (stdio)`）与映射 |
| `src/shared/runtime-input.ts`、`turn-record.ts`、`turn-intervention-validation.ts`、`provider-compatibility.ts` | Provider 白名单与校验 |
| `src/main/providers/index.ts`、`registry.ts`、`types.ts`、`bootstrap/provider-runtime.ts`、`smoke.ts` | 注册 adapter（受 `SCRY_EXPERIMENTAL_PROVIDERS` 门控）、`parseDisabledProviders`、回执来源 `antigravity_prompt_response`、smoke 夹具 |
| `src/main/claude-locate.ts`、`provider-detection.ts`、`provider-environment.ts` | `KNOWN_AGENTS`、`SCRY_AGY_PATH`、`resolveRuntimeCliBin`、login shell 精确变量捕获、默认清洗规则（含为其他 5 家清洗 `GEMINI_`/`AGY_`/`ANTIGRAVITY_`） |
| `src/main/run-stop-lifecycle.ts` | `STOP_ESCALATION_WINDOWS` 新增 `antigravity_acp: { gracefulMs: 5000, forceKillMs: 4000 }` |
| `src/main/mcp-config.ts`、`mcp-execution-trust.ts` | **A1 必做**：`providerMcpConfigPaths` 加显式 `'antigravity'` 分支（避免未知 id 落入 OpenCode 读 `opencode.json`），覆盖 `~/.gemini/config/mcp_config.json` 与 `cwd..gitRoot` 下 `{.agents,.agent,_agents,_agent}/mcp_config.json` 及启用插件 |
| `src/main/provider-compatibility-manifest.ts` | 加 `>=1.5.12 <1.6.0` 为 `experimental`（A9 后改 `supported`），其余未验证版本标 `unsupported`（仅实验开关可用） |
| `src/main/error-classify.ts` | `classifyError(message, providerId?)` 支持按 provider 区分未登录/配额提示，避免 `unauthorized` 误给 `claude` 提示 |
| `src/main/billing-ledger.ts`、`usage-ledger-repair.ts`、`src/renderer/format-usage.ts` | `antigravity` 缺失费用保持 `null`（不默认 `provider_reported`、不修补为 `0`）；`tokenCacheAccounting` 显式 `'separate'` |
| `src/host-runtime/host-runtime.ts`、`src/main/remote/desktop-host-reader.ts`、`provider-discovery.ts`、`src/daemon/login-start/policy-env.ts` | `listCommands`、`PROVIDERS`、远程发现受实验开关门控、`KNOWN_PROVIDERS` 与 `LOGIN_START_POLICY_ENV_KEYS` 加 `SCRY_EXPERIMENTAL_PROVIDERS` |
| `src/main/app-store.ts`、`conversation-schema.ts`、`conversation-side-chat-schema.ts`、`transcript-archive.ts`、`span-ledger.ts`、`trace-turn-progress.ts`、`llm-performance-history.ts`、`background-service-status.ts`、`host-continuation-identity.ts` | 持久化、投影与 `continuationKey` 枚举 |
| `src/renderer/hooks/integration-model.ts`、`useAgentSession-helpers.ts`、`provider-brand-marks.ts`、`AskUserQuestionDialog.tsx`、`McpTrustPanel.tsx`、`render-tests/capabilities.tsx` | 显示名、中性字母标、能力展示、MCP 面板展示用户级 hooks/MCP 来源 |
| `src/cli/status.ts`（及其他穷举处）、`GLOSSARY.md` | Recorder 不在范围，穷举处加显式「不支持」分支；术语表同步更新 |

#### 实施前必须先拆分的旧文件（`check-staged-file-size.mjs` 20,000 B 门禁）

实测当前字节数（`wc -c`）接近或已超过 20,000 B，改动前须在独立前置提交（A0.5）先按职责拆分：

| 文件 | 当前大小 | 预拆方向 |
|---|---|---|
| `src/main/claude-locate.ts` | 19,975 B | 拆出 `login-shell-env.ts`（环境变量捕获名单与合并） |
| `src/main/providers/smoke.ts` | 19,947 B | 拆出 fixture 定义或按 provider 拆 |
| `src/renderer/hooks/useAgentSession-helpers.ts` | 19,988 B | 拆出 provider 展示/能力辅助函数 |
| `src/shared/turn-record.ts` | 20,412 B | 拆出 provider 白名单与校验常量 |
| `src/main/billing-ledger.ts` | 27,029 B | 拆出 provider 费用来源判定 helper |
| `src/main/mcp-execution-trust.ts` | 34,346 B | 拆出扫描/指纹计算与授权存储 |
| `src/main/span-ledger.ts`、`transcript-archive.ts` | 47,906 B / 97,927 B | 仅拆出 Provider 枚举/白名单到共享小模块并复用，不直接堆改大文件 |
| `src/main/mcp-config.ts`、`desktop-host-reader.ts` | 18,048 B / 18,645 B | 接近上限，按需先抽路径表 |

### 4.3 进程模型（A0 实测确认）

- **一 run 一进程**：spawn → `initialize` → `session/new|resume|load` → 设模型/思考/模式 → `session/prompt` → 收口后**先关 stdin 等自然退出（宽限 3 s）**，超时才走 SIGTERM → SIGKILL。`forceKillScope: 'run_scoped'`（`types.ts:79-84`）。
- **A0 实测支撑〔`02-proto.json`、`07-lifecycle.json`〕**：热启动 `44 ms`；`PromptResponse` 后 600 ms 零尾随 `session/update`；关 stdin 后 `861 ms` 自然退出（code 0）并完整落盘；新进程 `session/resume` 耗时 `2.2 s`、**零历史重放**且准确回忆上下文；`session/load` 耗时 `1.9 s`、重放历史通知（须丢弃不进 trace）。
- **明确限制**：一 run 一进程模式下，`agy` 在轮次结束时若仍有未完结的后台子 Agent 或长跑 `/goal`，将随进程关闭被终止；须在 Provider 说明与用户文档里写明。
- **目录探测与缓存**：在 0700 临时目录跑短会话读取 `configOptions`；结果按 `continuationKey` 缓存，不随界面轮询起进程，且与同 profile 的 run 互斥（避免争用与额外进程）；不删除 `agy` 自己留下的临时目录会话记录（plan §9.1 D5）。
- **卡住保护**：prompt 期间既无更新也无未决审批/工具，15 分钟超时判失败（同 T3）。

### 4.4 远程设备

远程 discovery 自动暴露（受 `SCRY_EXPERIMENTAL_PROVIDERS` 控制）；远程权限上限照常裁剪权限档；未登录原因文本原样给远程，修复只能在宿主机；非 Gemini 模型名同样标「经 Antigravity 提供」。

## 5. 安全

### 5.1 进程身份、停止合同与独立进程组（关闭 B6）

- spawn 用 `detached: process.platform !== 'win32'`，立刻 `captureProcessIdentity(child.pid)`（同 `qoder-launch.ts:204-219`）。
- **停止阶段完全由 `RunStopLifecycle`（`src/main/run-stop-lifecycle.ts:64-140`）管理**，窗口条目 `antigravity_acp: { gracefulMs: 5000, forceKillMs: 4000 }`（实测 cancel 5–15 ms、空闲 SIGTERM 1,402 ms〔`08-cancel.json`〕）：
  1. `interrupt()`：若尚未拿到 `sessionId`（卡在 `initialize` / `session/new`），直接按身份发 `SIGTERM`；已有 `sessionId` 则先对所有未决 `session/request_permission` 回 `{ outcome: { outcome: 'cancelled' } }`，再发 `session/cancel` 通知。
  2. `forceKill()`：窗口届满由 `RunStopLifecycle` 触发，**在一次 `forceKill` 内完成**按身份 `SIGTERM` →（超时 2 s）`SIGKILL`；身份采不到或核对不符则拒发信号（fail closed），绝不 `pkill agy`。
- **实测独立进程组风险〔A0 实测 `08-cancel.json`〕**：`agy`（pgid 96401）把终端命令子进程 `sleep 20` 放进**独立进程组**（pid 96458, ppid 96401, pgid 96458）。`session/cancel` 生效时 `agy` 自己清理了子进程（残留为空），但若升级到 `SIGKILL`，`signalProcessTreeWithIdentity` 当前仅调用 `kill(-identity.pid, signal)` 无法触达独立 PGID 的后代！实现时必须对 `signalProcessTreeWithIdentity` 返回的已验身份 `nodes` 中 `pgid !== identity.pid` 的后代逐个发信号。
- **cancel 后收口判定**：
  - `PromptResponse.result.stopReason === 'cancelled'` → `cancelled`（附已有 `usage` 且标 `partial`）。
  - 发出 cancel 后仍收到 `stopReason: 'end_turn'` → 按实际结果收口并在 trace 记 `cancelRequestedBeforeEndTurn`，不丢已有输出。
  - 收到 JSON-RPC 错误 → 若已发起 cancel 按 `cancelled` 收口并保留原始错误码，否则判 `failed`。

### 5.2 环境清洗

启动环境经 `runtimeCliEnv(undefined, { providerId: 'antigravity' })` → `sanitizeProviderEnv`（含 `sanitizeNestedAgentEnv`），规则见 provider §2.3；不注入 T3 托管运行时专用变量（`PYTHONUNBUFFERED`、`ELECTRON_RUN_AS_NODE`、私有 `TMPDIR`）。

### 5.3 秘密、MCP 注入与日志（A0 实测 token 落盘）

- argv 固定为 `['acp']`（`full_access` 时为 `['acp', '--dangerously-skip-permissions']`），不带任何 token 或配置值；用 `argv-recorder.fixture.ts` 断言。
- **MCP 注入与 token 生命周期〔A0 实测 `06-mcp.json`〕**：实测 `session/new.mcpServers`（Streamable HTTP + `Authorization: Bearer` header）完全生效、argv 不含 token，**但 `agy 1.5.12` 会把请求体里的 bearer token 持久化写入 `conversations/<sessionId>.db`！**
  - 强制约束：Scry 历史检索 MCP 的 bearer token 必须**每 run 随机生成、run 结束立刻撤销并关闭本地 HTTP 服务**，绝不传入任何长期凭据；子进程同时套用 `historyReaderEnvironment`（loopback `NO_PROXY`）。
- **证据与日志分离**：
  - `recordNative` 原样写入原生流，**不得经过 `maskSecrets`**（遵循 `src/shared/trace.ts:466-467` 证据合同）。
  - 面向 UI、错误消息与远程设备的 stderr 尾巴过 `maskSecrets`，并扩展 `maskSecrets` 识别 Google API key（`AIza[A-Za-z0-9_-]+`）与 OAuth URL（`code`/`state`）。
  - 识别到 stdout 登录提示行（含一次性 OAuth `state`）整行丢弃，只记「检测到登录提示」；其他非 JSON stdout 行只计数不落日志。

### 5.4 仓库控制配置与 trust gate（关闭 B4、B5）

- **接线位置（B4）**：不改 `run-admission.ts` / `run-fork.ts` 的 provider 硬编码分支；把工作区配置指纹检查放进 `antigravity` adapter `run()` 的启动边界（fail closed），grant 持久化放在 `antigravity-config-trust.ts` 独立模块。
- **A0 实测 + 内置文档确认的完整加载面（B5）**：
  - **实测〔`05-paths.json`、`05b-paths-deep.json`〕**：`agy acp 1.5.12` 自动加载并触发了 `cwd` 与上级目录（至 `.git` 根）全部 4 个别名目录（`.agents/`、`.agent/`、`_agents/`、`_agent/`）与内联插件（`plugins/<name>/`）的 `SessionStart`/`PreToolUse` `hooks.json` 与 `mcp_config.json`，以及用户级 `~/.gemini/config/{hooks,mcp_config}.json`（23 个标记全部触发）；工作区级 `settings.json` 中的权限键未绕过审批（`wsSettingsPermCount: 1`），但**用户级 `~/.gemini/antigravity-cli/settings.json` 中的 `toolPermission`/`permissions.allow` 确实跳过了审批（`userSettingsPermCount: 0`）**；`plugins.json` 指向工作区外绝对路径的条目本次未触发，但内置规范明确文档化了工作区相对路径 `plugins.json`，仍纳入 fail-closed 门禁。

| 候选路径（`cwd` 至 `.git` 根逐级扫描） | 风险 | 处理 |
|---|---|---|
| `{.agents,.agent,_agents,_agent}/hooks.json` | 实测 `SessionStart`/`PreToolUse` 自动执行；`PreToolUse` 支持 `decision:"allow"` 与 `overwrite` 改参〔A0 实测 `05b` + 内置文档〕 | 指纹门禁（fail closed） |
| `{.agents,.agent,_agents,_agent}/mcp_config.json` | 实测 4 别名目录与上级目录均自动拉起 stdio/HTTP MCP〔A0 实测 `05/05b`〕 | 进 `providerMcpConfigPaths`，走现有 MCP 执行信任 |
| `{.agents,.agent,_agents,_agent}/plugins/<name>/{plugin.json,.antigravity-plugin/plugin.json,.gemini-plugin/plugin.json,hooks.json,mcp_config.json}` | 实测内联插件的 `hooks.json` 与 `mcp_config.json` 均自动执行〔A0 实测 `05b`〕 | 整个插件清单与可执行配置进指纹门禁 |
| `{.agents,.agent,_agents,_agent}/plugins.json` | `entries`/`inherits` 可指向其他目录〔内置文档〕 | 解析后将所有目标路径纳入指纹；越出允许范围、符号链接或解析失败直接拒绝 |
| `<ws>/.gemini/settings.json`、`<ws>/.gemini/antigravity-cli/settings.json`、`<ws>/.agents/settings.json`（及上级至 `.git` 根） | 1.5.12 实测未绕过审批，但防版本变化导致工作区抬高权限 | 检测到权限类键（`toolPermission`/`permissions`）直接**拒绝启动**并说明文件路径；其余可执行键同进指纹 |
| `~/.gemini/config/{mcp_config.json,hooks.json}` | 用户级配置；`mcp_config.json` 进入 `providerMcpConfigPaths` 即一并计入 MCP 指纹 | 照实记录，不与「不门禁」矛盾；在 MCP 面板展示用户级 hooks/MCP 来源 |
| `{.agents,.agent,_agents,_agent}/skills`、`AGENTS.md`、`GEMINI.md` | 文本指令 | 不进执行门禁（Scry 不是沙箱） |

- **门禁执行规则**：
  1. 指纹 = canonical cwd + 仓库根路径 + 所有命中文件的规范路径、大小、sha256（固定顺序）；任何符号链接、越出工作区/仓库根、超大小、JSON 解析失败 → **拒绝启动**并写明文件。
  2. 沿用 2026-09-21 政策：首次与指纹变化自动重验，记 `source: auto`，不弹窗、不显示成用户批准。
  3. 残余风险照实写进 Provider 说明：启动前检查与 `agy` 读取之间有 TOCTOU；`~/.gemini` 与 IDE/Gemini CLI 共用，上一轮获批工具改写用户级配置无法由启动前指纹拦截。
  4. 未知新版本可能新增配置面：兼容性清单把未验证版本标 `unsupported`，仅实验开关下允许，防止对新配置面 fail open。

### 5.5 权限文案

- `full_access`（`--dangerously-skip-permissions`）：
  > 让 Antigravity 不经询问执行工具（等同 `agy acp --dangerously-skip-permissions`）。这是本机用户权限，不是沙箱；Antigravity 自己的 deny 规则仍生效；提问仍需你回答。仓库里的 Hook、插件与 MCP 仍须通过指纹检查。
- `default`：若用户全局 `~/.gemini/antigravity-cli/settings.json` 使有效权限高于 `default` 或高于远程上限，拒绝启动并提示（provider §3 D3）。
