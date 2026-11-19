# P7 · Antigravity Provider：测试、拆分、Recorder 备注与待决定（只设计）

接 [P7-antigravity-provider](P7-antigravity-provider.md)（§0–§3）与 [P7-antigravity-integration](P7-antigravity-integration.md)（§4–§5）。标记含义见 provider 篇 §0.2。

## 6. 测试

### 6.1 假 ACP Agent 夹具（L0/L1，CI 可跑）

`src/main/providers/fixtures/fake-agy-acp.mjs`：纯 Node 脚本，按 Pi 夹具的做法写进临时目录、`chmod 0755`、经 `SCRY_AGY_PATH` 指过去，并 mock `shellEnv` 防止读到开发者的登录 shell（`src/main/providers/pi-test-fixture.ts:12-30`）。场景由测试写入夹具旁的 JSON 文件选择，不经环境变量传秘密。

| 场景 | 断言 |
|---|---|
| 正常一轮：文本、思考、工具、PromptResponse + usage | trace 顺序；token 按 Gemini 口径换算且 reasoning 不重复计入 total |
| 工具更新重复、乱序、只有 partial、未知 `sessionUpdate` 类型 | 一次逻辑调用；未知类型记原生流、不崩、不伪造事件 |
| 无 `usage` | 用量 `unavailable`，不是 0 |
| 带子 Agent 工具（`start_subagent`） | 用量覆盖 `partial`；不设 `turnRole` |
| `request_permission`：允许一次、始终允许、拒绝、用户取消 | 回给夹具的 `optionId` 正确；取消回 `cancelled` |
| `interaction_` 提问 | 走提问 UI；`full_access` 下也不自动回答 |
| `session/new` 回 -32000 / -32603 `No browser…` / stdout 登录提示行 | 判未登录；提示行不进日志与 trace；进程被停止 |
| stdout 混入非 JSON 行、超长行 | 非 JSON 旁路；超长行判协议错误并停止 |
| `session/cancel` 后回 `cancelled` | `settled`；结果 `cancelled` |
| 忽略 cancel | 走 SIGTERM → SIGKILL，阶段如实上报；无 pkill |
| 中途崩溃 | `failed` 带 stderr 尾巴（已打码）；不当成完成 |
| `resume` 可用 / 只有 `load`（重放历史） | 重放不进 trace；恢复后模型、思考档、模式被重设 |
| `configOptions`：模型含 Claude/GPT、`thought_level` 只对部分模型 | 标「经 Antigravity 提供」；档位不跨模型推断 |
| `set_mode` 拒绝 `yolo`/`auto_edit` | 目录不提供对应档；直接请求时报 `unsupportedPermissionMode` |
| `mcpServers` 回显 | 参数记录器（`argv-recorder.fixture.ts`）断言 argv 只有 `acp`，token 只在请求体 |

其他单测：环境清洗（`GEMINI_API_KEY` 默认删除、`SCRY_PROVIDER_ENV_ALLOW` 放行、其他 Provider 不再收到 `GEMINI_`/`AGY_`）；工作区配置门禁（符号链接、越界、超大、解析失败均拒绝，指纹变化重验并记 `source: auto`）；`continuationKey` 稳定性；版本 < 1.5.1 判 unavailable。

daemon 路径：新增独立测试文件，用现有 `src/daemon/host-process.harness.ts` 跑一轮假 Agent，**不改** `host-process.ts`。

### 6.2 macOS 真机清单（L3，维护者已授权真实 run 与费用）

前提：维护者 Mac 已装 `agy` 且已登录；`SCRY_HOST_DAEMON` 打开；临时 workspace 与临时 userData。HOME 必须是真实 HOME（登录在用户钥匙串里），这点与 S0-2「临时 HOME」不同，照实记录；`agy` 会写自己的 `~/.gemini` 数据。

| # | 项目 | 记录 |
|---|---|---|
| 1 | `agy --version`、`agy acp --help` | 版本、是否有 `--login`、`--dangerously-skip-permissions`、`--process-per-session` |
| 2 | `initialize` 原文 | `protocolVersion`、`agentCapabilities`（`loadSession`、`sessionCapabilities.{resume,fork,list}`、`promptCapabilities`）、`authMethods`、`modes` |
| 3 | 未登录（手工探针：`agy acp --gemini-dir <空临时目录>`，不走产品路径、不登出维护者） | 错误码；是否弹浏览器；stdout 是否出现登录提示 |
| 4 | 已登录 `session/new` | 模型列表（含 Claude/GPT）、`thought_level` |
| 5 | 一轮真实任务：读文件、改文件（审批允许与拒绝各一次）、跑命令、提问 | trace、文件足迹、审批往返 |
| 6 | 会话模式 | 可用模式；`yolo`/`auto_edit` 是否被拒；有无原生 always-proceed 入口（决定 D2） |
| 7 | 全局 `toolPermission=always-proceed` 时 ACP 的实际行为 | 决定 D3 |
| 8 | 工具执行中停止 | cancel 到 settle 的耗时；`ps` 按 PID 核对子进程已退出 |
| 9 | 终端命令子进程的进程组 | 是否与 `agy` 同组 |
| 10 | 重启后台服务后恢复会话 | `resume`/`load`；模型被重设 |
| 11 | `mcpServers`（HTTP + header）注入历史检索 | 是否生效；`ps -o args` 不含 token |
| 12 | 工作区 `.agents/hooks.json`、`.agents/mcp_config.json`（无害 Hook：写一个临时文件） | `agy acp` 是否加载；门禁拒绝路径是否生效 |
| 13 | PromptResponse `usage` | 与 agy 自己显示的用量对照 |
| 14 | 工作区副作用 | 是否新建 `.gemini/skills`、`.agents/skills` |
| 15 | 中文：`LANG=zh_CN.UTF-8`，路径 `~/临时/测试 项目`（含空格），中文文件名与提示词 | `file://` URI、`.meta` 里的 cwd、门禁的 canonical 路径（APFS 的 NFC/NFD 归一）、trace 不乱码 |
| 16 | 已配对手机发起一轮：审批往返、停止 | 远程链路 |
| 17 | 登录时启动的后台服务（launchd）读钥匙串 | 是否判已登录 |

每项与 Codex 同一任务对照记录；失败先存原始 ACP 日志（已打码）、退出码、版本。

### 6.3 Linux

Ubuntu runner 只跑 §6.1。真机：有装了 `agy` 的 Linux 桌面就跑 §6.2 第 1–15 项，并加「`systemd --user` 下 Secret Service 未解锁」一项；没有就标 **not-run**，不以 macOS 通过代替。

## 7. 拆分与顺序

| 编号 | 内容 | 大小 | 依赖 |
|---|---|---|---|
| A0 | 真机侦察：§6.2 第 1–4、6、7、9、11、12 项，只记录、不合代码 | S | 维护者在场 |
| A1 | ProviderId/RuntimeProvider 与各处枚举（§4.2 第二表的共享与持久化部分）、`policy-env.ts`、`host-runtime.ts`、`desktop-host-reader.ts` | S | — |
| A2 | `acp-client.ts` + 假 Agent 夹具 + 分帧/错误单测 | M | A1 |
| A3 | `antigravity-launch.ts`：发现、版本、环境清洗、spawn、身份、停止；`describe` | M | A2 |
| A4 | `antigravity-run.ts`/`-events.ts`/`-permissions.ts`/`-usage.ts`：一轮、流式、审批与提问、用量 | L | A3、A0 |
| A5 | `antigravity-catalog.ts`：模型、思考档、命令、Skill、登录探测与缓存 | M | A3 |
| A6 | `antigravity-config-trust.ts`、`providerMcpConfigPaths`、历史检索注入 | M | A3、A0 第 11、12 项 |
| A7 | 渲染层显示名/图标/文案、兼容性清单、`error-classify` | S | A5 |
| A8 | 输入回执 + `historicalContext` opt-in（侧边会话、交接） | M | A4 |
| A9 | macOS 真机验收（daemon 模式）与 Linux 标注 | S–M | 全部 |

- 约 4–5 周（单人）；A0 结果可能删掉 `full_access` 与历史检索两块工作。
- **不碰 `src/daemon/host-process.ts`**。A1 改的共享枚举文件与其他执行方可能冲突：A1 单独一个小提交、先合，冲突面最小。
- 所有新文件 < 20,000 字节；`antigravity-run.ts` 预计最大，事件映射已拆到 `-events.ts`，仍超就按 resume/prompt 再拆。
- 每段：L0 相关测试 + 类型检查；A9 前跑一次 L1。

## 8. Recorder 备注（范围外）

Scry 不录制终端里的 `agy`（决定 2）。以后若做 `scry init` 支持，现有线索：

| 项 | 内容 | 来源 |
|---|---|---|
| Hook 事件 | `PreToolUse`、`PostToolUse`、`PreInvocation`、`PostInvocation`、`Stop`、`SessionStart`；未见 `UserPromptSubmit`/`SessionEnd` | 〔官方摘要〕〔社区〕 |
| 配置位置 | 工作区 `.agents/hooks.json`、全局 `~/.gemini/config/hooks.json`、plugin 自带；`/hooks` 列出已加载项；`settings.json` 里的 hooks 键不加载（另有版本说法相反） | 〔官方摘要〕 |
| 负载 | 含 `transcriptPath`（驼峰） | 〔社区〕 |
| 原生记录 | `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` | 〔官方摘要〕 |
| 可靠性 | IDE 有 `Stop`/`PostToolUse` 不触发的报告；CLI 有 `PreToolUse` 触发的报告 | 〔社区〕 |

结论：机制存在，可行性中等。缺口：轮次起点要靠 `PreInvocation` 推断（无 `UserPromptSubmit`），`Stop` 的输出约定未核实；写入 `.agents/hooks.json` 本身是仓库控制的可执行配置，要走 Recorder 合同与 trust。本期不做任何实现。

## 9. 需要维护者决定

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | **条款风险**。搜索摘要显示 Google FAQ 称第三方工具经 Antigravity 个人登录访问服务违反条款，个人方案不支持把 `agy` 包进第三方应用，建议改用 Gemini Enterprise / AI Studio API key；论坛有封号报告。原文未能读取（§0.2） | a) 照决定 1 用个人账号真机验证；b) 验证改用 AI Studio API key（经 `SCRY_PROVIDER_ENV_ALLOW` 放行）或 Enterprise；c) 先暂停 | **b**，并先由维护者读一遍 FAQ 原文。产品里在 Provider 说明加一句「使用前请确认你的 Google 方案允许第三方客户端」，不替用户判断 |
| D2 | `agy acp` 若没有原生 always-proceed 入口，`full_access` 怎么办 | a) 不提供；b) Scry 端代答所有审批 | **a**。b 让 Scry 成了审批人，且 agy 的 deny 规则仍会拦，不是原生等价语义 |
| D3 | 用户全局 `toolPermission` 已是 `always-proceed`/`proceed-in-sandbox` 时的 `default` | a) 只读该键，如实改写 `default` 说明；b) 拒绝运行；c) 不管 | **a**（真机第 7 项确认 ACP 下确实生效后再定文案） |
| D4 | `continuationKey`：登录在钥匙串里，没有可哈希的凭据文件 | a) 用执行入口身份 + canonical `~/.gemini` + 放行变量的哈希，接受同一钥匙串换账号察觉不到；b) 无文件凭据就禁止跨 run 恢复（Qoder 现做法） | **a**。b 会让钥匙串用户永远不能恢复；换账号后的恢复失败由 agy 报错，Scry 如实显示 |
| D5 | 目录读取的短会话在用户 agy 数据目录留一条会话记录 | a) 留着并写明；b) 按 T3 做法只删 cwd 与 id 都匹配的自有文件 | **a**。记录只出现在临时 cwd 的 `/resume` 列表里；删 Provider 数据是额外写操作 |
| D6 | ACP 客户端 | a) 手写最小客户端；b) 引入官方 ACP SDK 依赖 | **a**，与 `pi-rpc.ts` 同风格，便于控制分帧上限；不承诺通用 ACP Provider |
| D7 | 标识与图标 | ProviderId `antigravity`、显示名 Antigravity、可执行 `agy`；图标用中性字母标还是官方图形 | 中性字母标，避免商标问题 |
| D8 | 默认可见性 | a) 装了 `agy` 就出现（标实验性）；b) 真机通过前需 `SCRY_EXPERIMENTAL_PROVIDERS=antigravity` 才出现 | **b**，直到 D1 有结论且 A9 通过 |

## 附：外部来源

- T3 Code `8cf97b5f`：`docs/user/providers-antigravity.md`、`docs/user/providers-acp.md`、`docs/user/permission-modes.md`；`apps/server/src/provider/{antigravityAuthSupport,antigravityCliRelease}.ts`、`acp/Antigravity{AcpSupport,Protocol,TurnOutcome,SessionFiles}.ts`、`Drivers/Antigravity{Driver,Usage,Skills}.ts`；`apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`；`packages/provider-acp/src/server/adapter.ts`。只借鉴结论，不复制代码。
- 仅见搜索摘要（未读原文）：<https://antigravity.google/docs/cli/acp/>、<https://antigravity.google/docs/faq>、<https://antigravity.google/docs/hooks?tab=cli>、<https://antigravity.google/docs/settings?tab=cli>、<https://antigravity.google/docs/cli/modes.md>、<https://antigravity.google/docs/agent-settings.md>、<https://antigravity.google/docs/install/?tab=cli>、<https://antigravity.google/docs/cli/commands/resume.md>。
- 社区：<https://github.com/google-antigravity/antigravity-cli/issues/565>、<https://discuss.ai.google.dev/t/is-invoking-the-official-agy-cli-from-a-local-ai-coding-assistant-allowed-on-an-individual-google-ai-account/185992>、<https://discuss.ai.google.dev/t/bug-antigravity-cli-agy-fails-to-persist-authentication-state-in-wsl-2-environment/146059>、<https://discuss.ai.google.dev/t/stop-and-posttooluse-hooks-in-agents-hooks-json-never-fire-antigravity-ide-1-107-0-windows/178288>、<https://medium.com/google-cloud/a-developers-guide-to-agent-hooks-in-antigravity-cli-4c1440febd11>。
