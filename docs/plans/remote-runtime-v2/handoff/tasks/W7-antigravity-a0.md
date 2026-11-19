# W7 · Antigravity：真机探测（A0）与设计定稿

执行方 B。前置：本机已安装 `agy` 并登录（维护者确认）。

## 背景与已定

设计：[P7-antigravity-provider](../../P7-antigravity-provider.md)、[-integration](../../P7-antigravity-integration.md)、[-plan](../../P7-antigravity-plan.md)。独立评审：[reports/P7-design-review.md](../reports/P7-design-review.md)（6 个阻塞项，多数依赖本任务的真机答案）。

维护者 2026-11-19 决定：

1. 真实 Antigravity 运行已授权（费用记在维护者的 Google 账号）。
2. 目标体验与 Codex、Qoder 一致：终端里能用的 `agy`，Scry 里就要能用；**Scry 不做登录，直接使用 CLI 已有的登录态**（维护者已知悉 Google 对第三方客户端使用个人登录可能有条款限制，决定使用）。
3. 可以在 Scry 里选权限：凡 `agy` 原生支持的模式都要提供；没有原生对应的不显示，**不伪造、不静默降档、不由 Scry 代答冒充完全访问**。
4. D2–D8 按设计推荐，并按评审意见调整（D4 先找非秘密账号标识；D8 实验开关先实现）。评审列出的「缺失决策」按评审推荐处理：不弹浏览器、不由 Scry 发起登录；未验证版本只在实验开关下可用；工作区设置含权限键时拒绝启动并说明；后台工作随进程结束被终止要写明；缺失费用记为未知而非 0；Windows 明确不支持。

## 第一部分：A0 真机探测（先做，不写产品代码）

探测脚本放 `scripts/`（可复用的入库），原始输出放 `~/.local/state/scry-handoff-evidence/W7/`，不提交到仓库。**不改用户的 `~/.gemini` 配置与登录项**；需要隔离时用临时副本，先确认凭据存储位置（钥匙串还是文件）再做任何「未登录」探测。逐项给出原始证据：

| # | 问题 | 决定什么 |
|---|---|---|
| 1 | `agy --version`；`agy acp` 的帮助与子命令、参数 | 最低版本、启动参数 |
| 2 | `initialize` 发 `protocolVersion: 1` 和 `2` 各自的原始响应（含 `agentInfo`、`agentCapabilities`、`authMethods`） | B1 |
| 3 | 不调 `authenticate` 直接 `session/new` 是否可用；已有凭据时 `authenticate(methodId)` 是否静默；是否会尝试打开浏览器 | B2 |
| 4 | 原生权限模式全集（会话模式、`toolPermission` 取值、是否有原生「总是执行」），每种模式下工具调用是否发 `request_permission`；`allow_always` 的持久范围（进程内 / 写用户配置） | D2、D3、权限选择 |
| 5 | 逐路径加载矩阵：工作区 `.agents/hooks.json`、`.agents/mcp_config.json`、`.gemini/settings.json`、旧 `.agent/`、plugin/extension 目录、cwd 上级目录、用户级 `~/.gemini/…`，哪些在 `agy acp` 下被加载；工作区设置能否覆盖权限 | B5 |
| 6 | `session/new` 传入的 `mcpServers`（含 headers）是否生效；会话参数是否被写入 `.meta`/`.db` | MCP 注入、token 生命周期 |
| 7 | 进程模型：PromptResponse 后关 stdin 是否落盘并自然退出；尾随 `session/update`；`session/resume` 与 `session/load` 的可用性与耗时；子 Agent 与 `/goal` 在进程结束时的表现 | 一 run 一进程还是长驻 |
| 8 | cancel：未决审批时的行为、cancel 后返回 `end_turn` 还是错误；SIGTERM 后的退出时间 | B6、`gracefulMs` |
| 9 | 用量字段（主 Agent / 子 Agent / 取消轮次）、是否回报实际应答模型、思考档来源；目录探测是否改用户默认模型 | 证据合同 |
| 10 | 非秘密的账号标识来源（settings 的 `auth.type`/project、ACP 是否返回账号） | D4 |
| 11 | 从 Finder/launchd 启动的进程能否读到登录态（钥匙串）；需要哪些环境变量 | B3、P5 登录时启动 |
| 12 | 中文路径工作区、中文系统语言下的基本运行 | L3 |

## 第二部分：设计定稿（文档）

根据 A0 答案与评审，修订三份 P7 文档：逐条处理评审的阻塞项与应修项，A0 已回答的问题写成确定结论（附证据路径），把「已定」与仍需维护者决定的事项分开。注意单文件 20,000 字节上限。修改清单要补全评审指出的遗漏文件，并写明哪些旧文件要先拆分（如 `claude-locate.ts`、`smoke.ts`）。

## 停止条件

完成两部分后**停下**，在 `reports/W7.md` 写报告（第一行状态），列出：A0 每项结论、设计改动、仍需维护者决定的事项（附推荐）。产品代码（A1 起）等核验方核对并补任务单后再开始。

真实运行只用 `agy`；遵守测量互斥规则；不改日常 App、iPhone、`com.scry.daemon`。
