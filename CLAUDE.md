# CLAUDE.md — Scry

> 本项目的稳定事实 + 读代码/改代码的陷阱。随仓库走。产品介绍见 README.md。

## 定位

Electron 桌面 app，用 **Claude Agent SDK**（模式 A）在主进程驱动本机 claude code，对话式实时观测其执行（可观测/可控制/可恢复）。**不是**旁路 tail transcript（那是被否决的模式 B，见任务档案）。

## 架构（三层）

- `src/renderer/`（React）：对话流（`App.tsx`，含 ToolItem/FilesSummary/TurnFooter/OverviewPanel/CliPicker/WorkdirPicker）+ 右栏纵览。只通过 `window.scry.*`（preload 暴露）和 main 通信。
- `src/main/`：`index.ts`（窗口 + IPC + 会话/工作目录/历史 + **启动清污染 env**）、`agent-runner.ts`（SDK `query()` 驱动 + interrupt + subagent tail）、`normalize.ts`（SDKMessage/transcript → TraceEvent，**纯函数、有单测**）、`claude-locate.ts`（扫 PATH 检测 agent CLI）。
- `src/shared/trace.ts`：统一 `TraceEvent` 模型（`kind` = tool/skill/agent/human/model/harness + baggage + 文件足迹）。

## 改代码必读陷阱（这一路踩过的坑）

1. **工具链必须 Node ≥ 22**。本机默认 nvm v20.17 会触发 EBADENGINE 且装不全 electron。所有命令前置 `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"`，或 `nvm use 22`。
2. **electron 二进制可能没下全**：报 `Error: Electron uninstall` → `node node_modules/electron/install.js`（同 maka-agent README 的坑）。
3. **认证 env 污染（关键）**：若 app 从一个父 Claude Code 会话内启动（开发时常见），会继承 `CLAUDECODE` / `CLAUDE_CODE_*` / `AI_AGENT` 等环境变量，SDK 驱动的 cli.js 会误判为「嵌套会话」→ `Not logged in · Please run /login`。`main/index.ts` 启动时已清掉这些。改启动逻辑别破坏它。（登录态本身在 macOS Keychain，不是 `~/.claude/.credentials.json`。）
4. **SDK `query()` 不是纯进程内**：底层 `spawn` 自带的 `cli.js`（claude code）。后果：① `electron.vite.config.ts` 用 `externalizeDepsPlugin` 把 SDK 留在 node_modules（别 bundle）；② 将来打包必须 `asarUnpack` 整个 `@anthropic-ai/claude-agent-sdk`，否则 ENOENT；③ GUI 从 Finder 启动不继承 shell PATH，子进程裸 `node` 可能找不到（打包待处理）。
5. **权限默认必须 fail closed**：`default` 使用 Provider 的原生审批/workspace sandbox；只有用户显式选择 `full_access` 时，Claude/Qoder 才映射为 `bypassPermissions` + `dangerously-skip-permissions`，Codex/OpenCode 使用各自等价的完全访问模式。能力不支持或探测失败时拒绝启动，不能退回完全访问。
6. **文件足迹有盲区**：只有 Read/Write/Edit/MultiEdit/NotebookEdit 有 `file_path`；**Glob/Grep 是 pattern/path（不算读写）**；Bash 的 `cat/rm/>`、MCP 写文件统计不到 → 用命令正则推断补（标「未必真读写」）。别假设它是全集。
7. **历史会话目录**：`~/.claude/projects/<cwd 把 / . _ 换成 ->/<sessionId>.jsonl`。大型工作区可能有**上百个** transcript（其中不少是 skill 路由的 `-p` 子会话），所以 `listSessions` 必须**先按 mtime 排序取前 N、只读文件头 64KB 找预览、按首条消息去重**，否则同步读全部大文件卡死主进程。
8. **subagent 内部明细**：SDK 主流看不到，靠 `SubagentStop` hook 的 `agent_transcript_path` tail 补一层；嵌套（subagent→subagent）的精确父子映射 SDK 不直接给，二期再做。
9. **sqlite 是原生模块（B2，`src/main/db.ts`）**：`better-sqlite3` 编译 `.node`，ABI 跟 node/electron 绑。`npm i` 后直接 `npm run dev` 会因 ABI 不符崩 → 必须 `./node_modules/.bin/electron-rebuild -f -w better-sqlite3` 为 electron 42 重建。打包：`electron-builder.yml` 已 `asarUnpack` 它（`.node` 不能在 asar 内 dlopen）+ 打包时 electron-builder 自动 @electron/rebuild。`db.ts` 加载失败整体降级 no-op（不连累 app）。本机企业 EDR 对 electron-rebuild 产出的 `.node` 不杀（实测 dev+打包都能跑；与 [[edr-blocks-native-builds]] 不冲突——那条针对本地新编译，这里是 prebuild/rebuild 产物）。`usage.jsonl`(B2-lite) 仍是「累计用量」的源，sqlite 加的是跨会话 GROUP BY 分析，两者并存。
10. **斜杠命令目录按 Provider 分流，不启动隐藏模型任务探测**：renderer 统一调用 `listCommands({ providerId, cwd })`，切换 Provider / cwd 时清空并重拉。Claude adapter 静态扫描 `<cwd>/.claude/skills` 和 `~/.claude/skills`，只返回启用的 Skill 命令；由于拿不到 `/help`、`/compact` 等内置命令，能力状态明确标为 `degraded`，不要恢复隐藏的 `query('hi')` 探测。Qoder 通过 SDK `supportedCommands()` 读取并按 cwd 短期缓存；OpenCode 通过 server API `v2.command.list()` 读取，发送时把 `/name args` 分派给 `session.command()`；Codex app-server 没有通用原生 slash 目录，Scry 把启用的 Skill 暴露为 `/skill-name` 发现别名，发送时转换成原生 Skill input（等价于 `$skill-name`），不伪造 `/help` 等内置命令。Claude 的 MCP 刷新另走配置级 `initialize` / `tools/list` 测试，不与命令目录复用隐藏会话。
11. **Provider 改写 PATH 前固定 Scry CLI**：`agent:start` 必须等待登录 shell 环境完成有界预热，`runtimeCliEnv()` 再从该原始 PATH 解析 recorder CLI，并通过 `SCRY_CLI_PATH` 把绝对路径传给 Provider hook；不能因慢 shell 超时或 Qoder/Node 管理器前置目录重新选择另一份全局 `scry`。显式路径失效时 hook 应 fail-open 跳过，只有变量缺失的旧集成才允许回退 `command -v scry`。这个契约不能写死某台机器的 `~/.local`、NVM 版本或 macOS 路径。

## 语义验收 / 反假数据（借鉴 CodePilot，硬规则）

Scry 是观测系统，用户信任「看到的数字/状态是真的」。每加一个用户可见的数字或状态字段，过三关：

1. **语义**：它代表什么？（如 footer 的 cost = 本轮 SDK `result.total_cost_usd`，不是累计；右栏汇总才是跨轮累计）
2. **来源**：从哪来、实测 / 估算 / 「最后已知」？必须在 UI 文案或 title 里可追溯。已有例子：文件足迹标「Bash/MCP 未统计」、MCP 状态标「Scry 自己连接测试的结果」、Skill 开关标「只影响 app 驱动会话」。
3. **反例**：普通路径 vs 边界路径数字是否一致？（没有工具调用时 tool 计数必须是 0，不是假的固定值；Bash 推断的文件标 `~` 区别于结构化的精确 W/R/E）

**禁止显示假数字 / 假状态**（token 恒为 0 却摆着、MCP 标 connected 但没真连）。宁可标「未知 / 未统计」也不编。改任何展示数字/状态的代码时，回这三关自检。

### 2026-07-04 补充：UI / 账单卫士易漏点

- **partial state 只能防崩溃，不能补业务事实**：数组类字段缺失可兜底成 `[]` 让列表不炸；但 `preflight`、`sharedReportExport`、`audit`、`reconciliation`、`gatewayPolicies` 这类治理/账单对象缺失时，必须显示「状态未知 / 缺少字段」，不能补 `0`、空格式、`refused`、空策略等看似确定的业务值。今天 review loop 抓到的 blocker 就是 `billingGuard` 把缺失 `audit` 渲染成「审计日志 0 行」。
- **账单卫士兼容旧 IPC 时要补反例测试**：只测完整 `BillingGuardianState` 不够，必须有 partial `billingState` 用例，断言不出现假 `0 行`、假 `$0.0000`、假空导出格式、假「暂无策略」。
- **App shell 顶栏必须区分 compact / with-filter**：welcome、graph、segments 没有 timeline filter，顶栏应是 compact 单行；chat 才用 `with-filter` 两排布局。不要为了 chat 的 filter 把所有页面顶栏撑高。
- **窄宽度要测**：右栏拖到较宽或 1024px 窗口时，主区会被压窄。`对话/拓扑/分段` 必须 `white-space: nowrap` 且保持完整，filter 自己横向滚动；不要让 tab 文案换行把顶栏撑高。
- **右侧面板语义**：`OverviewPanel` 只属于 chat；graph/segments 不展示对话右栏。Graph 里的右侧详情是拓扑自己的 span detail，可单独拖拽，不等同于 chat 右栏。
- **中文化检查不要只看主屏**：侧边栏、composer、右栏 tab、账单卫士按钮（如「同步 Admin 数据」「导入网关示例数据」）都要中文化；但协议名、工具名、model、source id 保持英文事实值。

## 改完代码后的验证 profile

### Project kind

Electron 桌面 app。主进程用 Claude Agent SDK 驱动本机 claude code;renderer 用 React 展示对话、工具、文件足迹、成本、右栏纵览、历史会话等。不是旁路 tail transcript。

### L1 静态 oracle

所有命令必须使用 Node 22:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run typecheck
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm test
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run build
git diff --check
```

按改动面追加:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run build:cli
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run mcpguard -- <args>
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run pack
```

若 Electron 二进制或 `better-sqlite3` ABI 有问题,先按本文件上方陷阱处理:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" node node_modules/electron/install.js
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" ./node_modules/.bin/electron-rebuild -f -w better-sqlite3
```

### L2 运行时 smoke

启动真实 Electron:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run dev -- --remoteDebuggingPort 9444
# 或 production preview:
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run start -- --remoteDebuggingPort 9444
```

启动成功判定:Electron 窗口可见;renderer 无 ErrorBoundary;`http://127.0.0.1:9444/json/list` 可列出 `Scry` renderer 目标时,可做 Browser/CDP runtime probe;`window.scry` preload API 至少包含 start/stop/activeRun/usageStats/stats/listSessions/listProjects/listMcp/listSkills 等关键 IPC。

如果没有 remote debugging 或需要验证静态 renderer，可用本地 `out/renderer` + mock `window.scry` 做 DOM/ARIA/溢出巡检，但结论只能算 Browser/CDP probe。Codex 自带 Playwright 可能没有下载浏览器，此时可指定系统 Chrome 可执行文件 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。Computer Use 选择 Electron 时必须传 Scry checkout 下的完整 app 路径 `<scry-repo>/node_modules/electron/dist/Electron.app`，否则可能误连到其它 Electron app。

### L3 用户路径

按改动面覆盖:

- 冷启动 welcome、sidebar、composer、右栏渲染。
- 选择 cwd、最近目录、历史会话、新会话。
- Chat 视图输入低成本 prompt,例如“只回复 OK,不读文件、不调用工具”,观察 turn lifecycle。
- Stop 路径:启动后停止,确认 stop 返回和 `turnDone` 状态。
- Graph / Segments / Analytics / Diagnostics 导航。
- 右栏 `纵览` / `账单卫士` / `MCP 信任`。
- splitter 拖拽、键盘调整、折叠恢复。
- CLI detection、MCP list/test、skills list/toggle 按改动面选择。
- `usageStats()`、`stats()`、`listSessions(cwd)`、`listProjects()` 在 run 后刷新。
- 展示数字/状态必须继续过上文“语义 / 来源 / 反例”三关。

真实 Electron 窗口 + Computer Use 用来验证窗口可见、焦点、鼠标、键盘、拖拽、系统菜单。Browser/CDP runtime probe 只用于 renderer DOM、IPC、ARIA、截图、状态机细节;最终回复必须区分“真实窗口操作”和“Browser/CDP runtime probe”。

### 可自动做 / 必须 checkpoint

可自动做 Node 22 下 typecheck/test/build/pack、启动 dev/preview Electron、Computer Use 窗口验收、Browser/CDP runtime probe、读取本地 app 数据和日志。必须 checkpoint:修改真实登录态、大额或敏感真实 API 调用、清空 SQLite / usage / sessions、强退 app、打包后替换用户日常使用的稳定 app(除非本次任务明确要求安装/发布)。

### 最终回复必须说明

写清 L1/L2/L3 实际做到哪层、命令结果、Electron 是否启动、真实窗口操作了哪些路径、Browser/CDP probe 探测了哪些 DOM/IPC/ARIA、未覆盖路径和残余风险。只跑 L1 不能写“端到端验证通过”。

## 二期 TODO

canUseTool 实时拦截审批 · codex/cursor adapter（spawn CLI 解析 stream-json）· active-state 任务级恢复 · 附件/BYOK 真功能 · 打包分发（asarUnpack + 绝对路径 node）· thinking 开启 · tool 卡看命令输出。

历史任务档案不随公开仓库发布；以本文件和仓库内 RFC 为当前事实来源。
