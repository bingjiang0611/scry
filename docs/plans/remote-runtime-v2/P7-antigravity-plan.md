# P7 · Antigravity Provider：测试、拆分、Recorder 备注与决策清单（设计定稿）

接 [P7-antigravity-provider](P7-antigravity-provider.md)（§0–§3）与 [P7-antigravity-integration](P7-antigravity-integration.md)（§4–§5）。标记含义见 provider 篇 §0.2。

## 6. 测试

### 6.1 假 ACP Agent 夹具（L0/L1，CI 可跑）

`src/main/providers/fixtures/fake-agy-acp.mjs`：纯 Node 脚本，写进临时目录、`chmod 0755`、经 `SCRY_AGY_PATH` 指向，mock `shellEnv`（同 `pi-test-fixture.ts:12-30`）；场景经夹具旁 JSON 文件注入，不经环境变量传秘密。

| 场景 | 断言 |
|---|---|
| 握手形状兼容（`protocolVersion: 1` 与 `2`） | 按响应形状校验通过；版本下限只看 `agy --version`；`clientCapabilities` 声明 `fs=false, terminal=false` |
| 正常一轮：文本、思考、工具、`usage_update`、PromptResponse + `usage` | trace 顺序；`total = input + cachedRead + cachedWrite + output`（`thoughtTokens` **不重复加**）；`modelStatus: 'unobserved'`；费用 `null` 不成 0 |
| 工具更新重复、乱序、未先见 `tool_call` 的 `request_permission`、未知 `sessionUpdate` | 一次逻辑调用；未先见 `tool_call` 亦建逻辑调用；未知类型原样进原生流、不崩 |
| 无 `usage` / 取消轮次 / 含子 Agent | 无 `usage` 标 `unavailable`（非 0）；取消或含子 Agent 标 `partial` |
| `request_permission`（字符串 `id`、同 `kind` 多选项、取消） | 原样保留全部选项；选定 `optionId` 回传正确；取消回 `cancelled` |
| `interaction_` 提问 | 走提问 UI；`full_access` 下也不自动回答 |
| 未登录：`-32000` / `-32603 No browser…` / stdout 登录提示行；显式放行 `GEMINI_API_KEY` | 判未登录；提示行整行丢弃不进日志与 trace；`BROWSER` 为退出 0 脚本；仅显式放行 `GEMINI_API_KEY`/ADC 且遇 `-32000` 时调对应非浏览器 `authenticate`，绝不对 OAuth 调 `authenticate` |
| 非 JSON stdout 行、超过 16 MiB 单行 | 非 JSON 只计数不落日志；超 16 MiB 判协议错误并停止 |
| `session/cancel`（含未决审批、无 `sessionId` 阶段、忽略 cancel） | 未决审批先回 `cancelled`；无 `sessionId` 直接 SIGTERM；忽略 cancel 由 `RunStopLifecycle` 升级 `forceKill`（含独立 PGID 后代，无 pkill） |
| 崩溃与 stderr 尾巴 | `failed`，UI/远程错误经 `maskSecrets`（含 `AIza…` 与 OAuth URL）打码，原生流原样保留 |
| `resume`（零重放）与 `load`（重放） | `load` 重放不进 trace；恢复后重设模型、思考档、模式；关 stdin 自然退出 |
| `configOptions`：多厂商模型、动态 `thought_level` | 标「经 Antigravity 提供」；档位随模型变化、不跨模型推断 |
| 权限模式：`default`、`accept-edits`、`full_access`（`--dangerously-skip-permissions`）、非法档 | 正确映射或报 `unsupportedPermissionMode`；全局权限高于所选/远程上限拒绝启动 |
| `mcpServers` 注入 | `argv-recorder.fixture.ts` 断言 argv 无 token；run 结束立刻撤销 token 并关服 |

其他单测：
- 环境变量清洗（默认清 `GEMINI_API_KEY`/`AGY_ADC_AUTH`/`SSH_*`、`SCRY_PROVIDER_ENV_ALLOW` 逐个放行、其余 5 个 Provider 清洗 `GEMINI_`/`AGY_`/`ANTIGRAVITY_`）。
- 工作区配置门禁（`cwd..gitRoot` 4 别名目录 `.agents`/`.agent`/`_agents`/`_agent`、`hooks.json`、`mcp_config.json`、`plugins/<name>/`、`plugins.json` 越界拒绝、工作区 `settings.json` 含权限键拒绝、符号链接拒绝、指纹变化重验记 `source: auto`）。
- `format-usage.ts`（`antigravity` / `antigravity_acp` 为 `separate`）、`billing-ledger.ts` 与 `usage-ledger-repair.ts`（缺失费用不记 0）、`error-classify.ts`（带 `providerId` 不串台）、`SCRY_EXPERIMENTAL_PROVIDERS`（隐藏注册/探测/远程 discovery 且进 `LOGIN_START_POLICY_ENV_KEYS`）。
- daemon 路径：用 `src/daemon/host-process.harness.ts` 跑假 Agent，**不改 `host-process.ts`**。

### 6.2 macOS 真机清单（L3）与 A0 实测状态

复用探测脚本已入库：[scripts/agy-a0-probe.mjs](../../scripts/agy-a0-probe.mjs)（及 `scripts/agy-a0-probe/`），原始输出存 `~/.local/state/scry-handoff-evidence/W7/`。环境：macOS 27.0（arm64）、`agy 1.5.12`。

| # | 项目 | A0 状态 | 实测结论 / 证据 |
|---|---|---|---|
| 1 | `agy --version`、`agy acp --help` | **已测** | `1.5.12`；支持 `--dangerously-skip-permissions`、`--sandbox`、`--login`、`--gemini-dir`、`--process-per-session`（`01-cli-and-layout.txt`、`01b-acp-help-and-creds.txt`） |
| 2 | `initialize` 发 `1` 与 `2` 原文 | **已测** | 均返回 `protocolVersion: 1`、`agentInfo.version: 1.5.12`、`resume/load/list/close`（无 `fork`）、4 个 `authMethods`（`02-proto.json`） |
| 3 | 登录与 `authenticate`、未登录隔离 | **已测** | 已登录跳过 `authenticate` 直接 `session/new` 成功；未登录返回 `-32000`，零弹浏览器；仅设 `GEMINI_API_KEY` 不调 `authenticate` 仍报 `-32000`（须在显式放行时调 `authenticate("gemini-api-key")`）；凭据按非 SSH=钥匙串（`svce=gemini`/`acct=antigravity`）、SSH=文件双模式（`03-auth.json`、`03b-auth-apikey.json`） |
| 4 | 原生权限模式全集与审批 | **已测** | 4 个原生模式均可 `set_mode`：`default` 对 `write_file` 与 `run_command` 均询问；`accept-edits` 自动放行 `write_file`、仍问 `run_command`；`auto` 均自动放行；`plan` 不写文件、问 `run_command`；`--dangerously-skip-permissions` 实测 `permCount=0`；`request_permission` `id` 为字符串且仅给 `allow_once`/`reject_once`（无 `allow_always`，不改 `settings.json`）（`04-modes.json`、`04b-modes-deep.json`） |
| 5 | 逐路径加载矩阵与工作区/用户权限覆盖 | **已测** | 23 个标记证实 `cwd..gitRoot` 全部 4 别名目录（`.agents`/`.agent`/`_agents`/`_agent`）、内联插件 `plugins/<name>/` 与 `~/.gemini/config/` 的 `hooks.json` 与 `mcp_config.json` 均自动执行；工作区 `settings.json` 未绕过审批（`wsSettingsPermCount=1`），**用户级 `~/.gemini/antigravity-cli/settings.json` 确实绕过审批（`userSettingsPermCount=0`）**；不新建 `skills` 目录（`05-paths.json`、`05b-paths-deep.json`） |
| 6 | `session/new.mcpServers` 与落盘检查 | **已测** | HTTP + Bearer header 生效、argv 无 token，**但 token 写入了 `conversations/<id>.db`**（`06-mcp.json`） |
| 7 | 进程模型：关 stdin、尾随通知、`resume`/`load`、子 Agent | **已测** | 无尾随通知；关 stdin 861 ms 自然退出落盘；`resume` 2.2 s 零重放回忆成功；`load` 1.9 s 重放 5 条；子 Agent 工具名 `invoke_subagent`（`kind: "other"`）（`07-lifecycle.json`、`09b-subagent.json`） |
| 8 | cancel、子进程组与 SIGTERM | **已测** | 未决审批 5 ms、命令执行 15 ms 均回 `cancelled` 且子进程清理；**命令子进程在独立 PGID**；空闲 SIGTERM 1,402 ms 退出（`08-cancel.json`） |
| 9 | 用量口径、动态思考档、模型切换副作用与子 Agent 用量 | **已测** | `total = input + cachedRead + cachedWrite + output`（`thoughtTokens` 已含在 `output` 内）；不报实际模型；切模型不改 `settings.json`；含 `invoke_subagent` 轮次不单列子 Agent 用量（须标 `partial`）（`09-usage.json`、`09b-subagent.json`） |
| 10 | 非秘密账号标识 | **已测** | 配置文件与 ACP 均无邮箱/用户 ID，仅 `onboarding.json`、`default_project_id.txt`、ACP `_meta.antigravity.tier`（`10-account-files.txt`、`03-auth.json`） |
| 11 | macOS `launchd` 最小环境读登录态 | **已测** | 仅 `HOME`+`PATH`+`BROWSER` 下 `session/new` 成功返回 11 个模型（`11-launchd.json`） |
| 12 | 中文路径与 `LANG=zh_CN.UTF-8` | **已测** | 含空格中文目录 `测试 项目` 与中文文件 `说明.txt` 正常读写、`replyText` 与 `toolLocations` 均为原样 UTF-8 无乱码，723 ms 自然退出（`12-zh.json`） |
| A9 | 完整 Scry daemon 端到端 + 手机审批/停止 | **A9 阶段** | 代码完成后执行，与 Codex 同任务对照 |

### 6.3 Linux

Ubuntu CI 跑 §6.1。真机有装 `agy` 的 Linux 桌面则跑 §6.2 对应项并加「`systemd --user` Secret Service 未解锁」；无则标 **not-run**，不以 macOS 替代。

## 7. 拆分与顺序

按评审工期评估：完整范围（含 A8）约 **6–8 周**；**4–5 周**可行基线为 A0.5–A5 + A6 门禁（不含历史检索注入与 A8）。A0 12 项探测已全部完成，可进入 A0.5 / A1 排期。

| 编号 | 内容 | 大小 | 依赖 |
|---|---|---|---|
| A0 | 真机探测（12/12 全部完成）与设计定稿 | S | 已完成 |
| A0.5 | 预拆超限/临限旧文件：`claude-locate.ts`、`smoke.ts`、`useAgentSession-helpers.ts`、`turn-record.ts`、`billing-ledger.ts`、`mcp-execution-trust.ts` 等（零行为变化） | S | A0 |
| A1 | `ProviderId`/`RuntimeProvider` 枚举、`mcp-config.ts` 显式分支、`SCRY_EXPERIMENTAL_PROVIDERS` 与 `LOGIN_START_POLICY_ENV_KEYS`、`policy-env.ts`、`host-runtime.ts`、`desktop-host-reader.ts`、`run-stop-lifecycle.ts` | S | A0.5 |
| A2 | `acp-client.ts`（16 MiB 上限、字符串 id、非 JSON 计数）+ 假 Agent 夹具 + 单测 | M | A1 |
| A3 | `antigravity-launch.ts`（发现、版本、清洗、去 `SSH_*`、`BROWSER` 退出 0、停止含独立 PGID 后代）+ `describe` | M | A2 |
| A4 | `antigravity-run.ts`/`-events.ts`/`-permissions.ts`/`-usage.ts`（一轮、审批/提问、`separate` 用量、费用 `null` 修复） | L | A3 |
| A5 | `antigravity-catalog.ts`（模型、动态思考档、命令、Skill、缓存与互斥） | M | A3 |
| A6 | `antigravity-config-trust.ts`（4 别名目录 + `cwd..gitRoot` + 插件/`plugins.json` + 权限键拒绝）+ run 级历史检索 MCP（轮末撤销 token） | M | A3 |
| A7 | 渲染层显示名/中性字母标/MCP 面板来源、兼容性清单、`error-classify(providerId)`、`GLOSSARY.md` | S | A5 |
| A8 | 输入回执 + `historicalContext`（侧边会话、交接，可选后置） | M | A4 |
| A9 | macOS daemon 真机验收（含手机远程）与 Linux 标注 | S–M | A1–A7 |

**不碰 `src/daemon/host-process.ts`**；所有新文件与改动的旧文件严格 `< 20,000` 字节。

## 8. Recorder 备注（范围外）

本期不实现 `scry init` 对 `agy` 的录制。本机 `agy 1.5.12` 内置 `agy-customizations/docs/hooks.md` 证实：
- **配置位置**：工作区 `{.agents,.agent,_agents,_agent}/hooks.json`、全局 `~/.gemini/config/hooks.json`、插件根目录 `<plugin>/hooks.json`。
- **Schema**：顶层键为 hook 名称（非 `hooks` 包装），支持 `SessionStart`、`PreToolUse`、`PostToolUse`、`PreInvocation`、`PostInvocation`、`Stop`（无 `UserPromptSubmit`/`SessionEnd`）；仅支持 `type: "command"` 同步执行。
- **负载**：stdin 传 camelCase JSON（含 `conversationId`、`workspacePaths`、`transcriptPath`、`artifactDirectoryPath`、`modelName`、`lastUserInput`、`hookEventName`、`cwd`）；CLI 日志在 `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`。
- **缺口**：轮次起点仍需靠 `PreInvocation` 推断，写入工作区 `hooks.json` 需走 Recorder 合同与 trust。

## 9. 决策清单（已定 vs 待维护者决定）

### 9.1 已定（维护者 2026-11-19 / 2026-11-20 + A0 实测闭合）

| # | 项 | 已定结论 |
|---|---|---|
| D1 | 登录与条款 | 复用 CLI 登录态，不做登录、不弹浏览器；文案中性提示条款风险，不下违规结论 |
| D2 | 原生权限入口 | 实测存在原生 `accept-edits`（→ `auto_accept_edits`）与 `--dangerously-skip-permissions`（→ `full_access`）；无原生对应不伪造、不代答 |
| D3 | 全局权限覆盖 | 读 `~/.gemini/antigravity-cli/settings.json`（实测会跳过审批），有效权限高于所选档位或远程上限时拒绝启动，turn record 记有效档位 |
| D4 | `continuationKey` 账号标识 | 采纳方案 (a)：哈希执行入口 + canonical `~/.gemini` + 放行变量（文件存储时附加 token 文件哈希），钥匙串模式界面标「账号未验证」并接受换账号察觉不到 |
| D5 | 目录探测记录 | 在 0700 临时目录跑短会话，按 `continuationKey` 缓存且与同 profile 的 run 互斥，不删用户 agy 数据 |
| D6 | ACP 客户端 | 手写最小客户端，不引外部 SDK |
| D7 | 标识与图标 | `antigravity` / `Antigravity` / `agy` + 中性字母标 |
| D8 | 可见性与门控 | 新建 `SCRY_EXPERIMENTAL_PROVIDERS=antigravity` 管控注册/探测/远程 discovery，并入 `LOGIN_START_POLICY_ENV_KEYS`；未验证版本仅实验开关可用 |
| D9 | 原生 `auto` 模式 | 采纳方案 (a)：首版只提供语义严格对应的 `default`、`auto_accept_edits`（`accept-edits`）、`full_access`（`--dangerously-skip-permissions`），不把 `auto` 映射为 `auto_review` |
| D10 | `SSH_*` 与双存储迁移 | 采纳方案 (a)：启动 `agy acp` 固定剥离 `SSH_CLIENT`/`SSH_CONNECTION`/`SSH_TTY`（除非用户显式放行 `AGY_ACP_FORCE_FILE_STORAGE`），并在文档写明 SSH 登录后首次桌面运行会触发 `agy` 迁入钥匙串 |
| M1–M4 | 缺失决策 | 工作区设置含权限键拒绝启动并说明；一 run 一进程终止后台子 Agent/`/goal` 写明；缺失费用记 `null`（未知）不记 0；Windows 明确不支持 |

### 9.2 仍需维护者决定

无（D1–D10 及 A0 全部 12 项均已闭合；A1 起实现按维护者排期与核验方任务单推进）。

## 附：外部来源与 A0 证据

- 本机 A0 实测（`agy 1.5.12`，2026-11-20）：`~/.local/state/scry-handoff-evidence/W7/{01-cli-and-layout.txt,01b-acp-help-and-creds.txt,01c-settings-and-keychain.txt,01d-subcommands-and-cache.txt,02-proto.json,03-auth.json,03b-auth-apikey.json,04-modes.json,04b-modes-deep.json,05-paths.json,05b-paths-deep.json,06-mcp.json,07-lifecycle.json,08-cancel.json,09-usage.json,09b-subagent.json,10-account-files.txt,11-launchd.json,12-zh.json}`。
- 本机内置规范：`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/{SKILL.md,docs/hooks.md,docs/plugins.md,docs/mcp_servers.md,docs/json_configs.md}`。
- 历史参考：T3 Code `8cf97b5f`（仅在 A0 未覆盖细节作对照，不复制代码）。
