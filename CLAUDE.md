# CLAUDE.md — Scry

> 只记录跨任务稳定、从 README 不易推导的约束；产品能力与当前状态见 `README.md`，脚本以 `package.json` 为准。

## 项目边界

- Scry 是本地优先的 Electron + React + TypeScript 桌面应用，通过 Provider adapter 驱动本机 AI agent，并展示会话、工具调用、文件足迹、用量与诊断。
- 当前 Provider 包括 Claude、Codex、Qoder、OpenCode 和可配置的 Pi profile。`src/main/agent-runner.ts` 只是 Claude Agent SDK runner，不代表全局架构。
- renderer 只能通过 preload 暴露的 `window.scry` 窄 IPC 访问主进程；不得启用 Node integration 或新增任意命令 IPC。
- 主要边界：`src/renderer/`（UI）、`src/preload/`（IPC 边界）、`src/main/`（窗口、持久化、治理与 Provider）、`src/shared/`（跨进程合同）、`src/core/turn-recorder/`（App/CLI 共用记录核心）。

## 不可破坏的约束

### Provider 与权限

- Provider 差异必须留在 `src/main/providers/` 的 adapter/facet 内，renderer 消费统一 capability envelope；不支持、探测失败或字段缺失要显式显示 `unsupported` / `degraded` / `unknown`。
- 权限默认 fail closed。只有用户显式选择 `full_access` 才映射到各 Provider 的完全访问模式；能力不支持或探测失败时不得退回完全访问。
- Skill、命令目录、MCP、账户与运行控制按 Provider 独立实现。不要用隐藏模型会话伪造能力探测或内置命令。
- 开发时可能从父 agent 会话启动。`src/main/index.ts` 与 `src/main/claude-locate.ts` 会清理 `CLAUDECODE`、`CLAUDE_CODE_*`、`AI_AGENT` 等嵌套会话环境变量；改启动或 PATH 逻辑时保留这条隔离。

### 观测数据必须诚实

- 每个用户可见数字或状态都要能回答：语义是什么、来源是什么、缺失或边界输入如何显示。
- 不得把缺失治理/账单字段补成 `0`、空列表、`refused` 或“暂无策略”等确定事实。结构性数组可用 `[]` 防崩溃，业务事实缺失必须显示“未知/未统计”。
- 文件足迹不是完整审计：结构化工具、Bash 推断与 MCP 证据要区分；推断值不得冒充精确读写。
- 当前会话、跨会话分析、Provider 状态和 Scry 自己执行的连接测试不可混为一谈。
- 修改数字、状态、兼容旧 IPC 或 partial state 时，补普通路径与缺字段反例测试。

### 持久化、原生模块与打包

- Node 工具链使用 Node 22；不要把某台机器的绝对 Node 路径写进脚本。
- `better-sqlite3` 与 `node-pty` 是 Electron ABI 原生模块。开发期 ABI 不匹配时运行 `electron-rebuild`；打包必须保持 `electron-builder.yml` 的 `asarUnpack` 与 `scripts/prepare-node-pty.mjs` 检查。
- SQLite 加载失败允许降级，但 UI 不能把降级态显示为零数据或健康态。
- 安装包固定使用 `Resources/bin/scry` 与同源 recorder dist；开发环境才允许 PATH fallback。显式 `SCRY_CLI_PATH` 是 authoritative，失效时不得偷偷换成另一个 CLI。
- 内置终端由主进程通过 `node-pty` 管理，renderer 只持有窄 IPC/xterm 视图。终端输出默认只驻留内存；不要承诺关闭 PTY 能杀死已脱离控制终端的进程。

## 验证 profile

### 文档或注释改动

```bash
git diff --check
```

核对文中的路径、脚本名和能力声明仍存在；不需要为纯文档改动构建、打包或递增 App 版本。

### L1：代码静态验证

使用 Node 22：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

按改动面追加：

```bash
npm run build:cli     # recorder/CLI
npm run mcpguard -- <args>
npm run pack          # 完整打包与 packaged/security smoke
```

Electron 二进制或 SQLite ABI 异常时再运行：

```bash
node node_modules/electron/install.js
./node_modules/.bin/electron-rebuild -f -w better-sqlite3
```

### L2/L3：运行时与用户路径

- UI/IPC 改动：启动真实 Electron（`npm run dev` 或 `npm run start`），检查窗口、renderer 错误、preload API 与受影响视图。
- 打包/原生模块/私有 CLI 改动：执行 `npm run pack`；需要交付日用 App 时执行 `npm run install:mac` 后从安装包验证。
- 按影响覆盖新会话、历史/项目切换、start/stop、Provider/权限、MCP/Skill、分析/诊断、终端和布局；不要为无关改动机械跑遍全部路径。
- Browser/CDP 只能证明 renderer DOM、IPC、ARIA 与状态机；真实窗口焦点、拖拽、菜单和进程行为要用真实 Electron 验证。最终报告区分两类证据。

## 操作边界与交付说明

可自动执行本地检查、构建、打包、安装和只读数据检查。修改真实登录态、大额/敏感 API 调用、清空 SQLite/usage/session 数据或强退用户正在使用的 App 前必须 checkpoint。

最终回复写明实际完成的 L1/L2/L3、命令结果、是否打包/安装、真实窗口与 Browser/CDP 各验证了什么，以及未覆盖路径和残余风险；只跑 L1 不得声称端到端通过。
