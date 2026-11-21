结论：探测与设计定稿通过；3 项待维护者决定，4 项补测待跑

# W7 核验（核验方，2026-11-20）

A0 在 `agy 1.5.12` 上回答了评审的 6 个阻塞项，证据齐全，设计已按实测改写：
- B1：发 1 或 2 都回 `protocolVersion: 1`，按响应形状判定。
- B2：已登录时不调 `authenticate` 也能 `session/new`；未登录返回 `-32000 Authentication required`；全程用退出码 0 的假 `BROWSER`，未弹浏览器。
- B3：凭据在没有 `SSH_*` 时放钥匙串（`svce=gemini`、`acct=antigravity`），有 `SSH_*` 时只读文件；launchd 最小环境（HOME、PATH、BROWSER）可正常建会话。
- B4–B6：门禁放进适配器启动边界；`agy` 从 cwd 向上到 `.git` 根、在 4 个别名目录下加载 `hooks.json`、`mcp_config.json`、插件，全部进指纹；接入 `RunStopLifecycle`，命令子进程在独立进程组，强杀要按身份逐个清理后代。
- 权限：原生有 `default`、`accept-edits`、`auto`、`plan`，以及 `--dangerously-skip-permissions`（实测零审批直接执行）。
- MCP：`session/new` 注入的 Bearer 生效且不进 argv，但会被写进 `conversations/<id>.db`，token 必须按 run 生成、轮末撤销。
- 用量：`totalTokens = input + cachedRead + cachedWrite + output`，思考 token 已含在 output 内；不回报实际应答模型。
- 工期修正为 6–8 周，加入 A0.5 预拆分阶段。

**需注意（非 Scry 造成）**：探测期间 `agy` 自己在刷新 token 时把文件里的凭据迁进了钥匙串并删除原文件；桌面与 launchd 下登录正常，但从带 `SSH_*` 的 SSH 会话里运行 `agy` 会显示未登录。

**待补测**（执行方 A 的长跑锁已释放，可以跑）：第 12 项中文路径与中文 locale；路径矩阵细化（真实 `hooks.json` 结构、`_agents`、插件、用户级设置）；`accept-edits`/`auto`/`plan` 下写文件审批与 `allow_always` 的范围；`GEMINI_API_KEY` 免 `authenticate`；子 Agent 的工具名与用量。

**待维护者决定**：D4、D9、D10，见 `P7-antigravity-plan.md` §9.2。

## 复核（第二轮，2026-11-20，提交 `e36b21c0`、`d6914cfe`）

结论：**通过**。D4、D9、D10 已写入 §9.1；5 项补测全部完成并有证据：中文路径与 zh_CN 正常；23 个加载标记全部触发（cwd 至 `.git` 根的 4 个别名目录、插件、用户级 `~/.gemini/config`）；工作区 `.gemini/settings.json` 的权限键**不**绕过审批，但用户级 `~/.gemini/antigravity-cli/settings.json` 的 `toolPermission`/`permissions.allow` **会**绕过审批——D3 实现时必须读用户级设置，有效权限高于所选档位或远程上限时拒绝启动；`accept-edits` 只放行写文件、命令仍审批，与 `auto_accept_edits` 一致；`auto` 放行安全命令，不映射到自动审查；1.5.12 从不提供 `allow_always`；`GEMINI_API_KEY` 只有在用户显式放行且收到 `-32000` 时才调用非浏览器的 `authenticate`；子 Agent 以 `invoke_subagent` 出现，用量不单列，覆盖标 partial。可以进入 A0.5 起的实现（任务单 W8）。
