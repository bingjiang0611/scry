# Scry

Scry 是一个本地优先的 AI coding agent 观测与治理桌面应用。它在应用内驱动本机 agent CLI，把终端里的执行过程呈现为可检查的对话、工具调用、文件足迹、拓扑、分段、用量与诊断信息。

> 当前状态：**MVP / WIP**。项目主要在 macOS 上开发和验证，暂不提供已签名、公证的安装包。

## 能做什么

- 在桌面界面中启动和停止 agent turn，流式查看模型输出与工具调用。
- 按工作目录管理新会话、历史会话和最近项目。
- 汇总 token、cost、duration、tool/MCP 调用与文件读写足迹。
- 提供对话、执行拓扑、分段分析、账单卫士、MCP 信任和诊断视图。
- 通过 Provider adapter 接入 Claude、Codex、Qoder 和 OpenCode；各 Provider 的可用能力取决于本机 CLI/SDK 与登录状态。
- 提供独立的 `@scry/turn-recorder` CLI，在本地记录顶层 agent turn。

## 安全与数据边界

> **重要：当前 MVP 会绕过部分 Provider 的逐工具权限确认。** Claude 和 Qoder 运行路径默认使用 `bypassPermissions` / `dangerously-skip-permissions`。Agent 可以在其运行时权限范围内读取、修改文件并执行命令，不保证被限制在所选工作目录内。只在你信任的代码库和可恢复环境中使用。

- Scry 的会话索引、观测数据和 turn-recorder 记录保存在本机；turn-recorder 默认只写工作区的 `.scry/`，不实现上传。
- Scry 本身没有项目数据上传后端，但 Provider CLI/SDK 会连接各自服务；其数据处理遵循对应 Provider 的配置、许可证和服务条款。
- Bash、MCP 和第三方工具可能访问 Scry 无法完整统计的文件或网络资源，文件足迹不是安全沙箱或完整审计日志。
- 实时逐工具审批仍在计划中。在它完成前，不要把 Scry 当作权限隔离层。

## Provider 状态

| Provider | 接入方式 | 状态 |
| --- | --- | --- |
| Claude | Claude Agent SDK / 本机 Claude Code | 主要开发路径 |
| Codex | 本机 Codex app-server | 实验性 |
| Qoder | Qoder Agent SDK | 实验性 |
| OpenCode | OpenCode SDK / server | 实验性 |

## 开发环境

前置要求：

- macOS（当前主要开发与验证平台）
- Node.js 22 或更高版本
- 至少一个已安装并完成登录的受支持 agent CLI

```bash
nvm use 22
npm ci

# 如果 Electron 二进制没有完整下载
node node_modules/electron/install.js

# better-sqlite3 需要针对当前 Electron ABI 重建时
./node_modules/.bin/electron-rebuild -f -w better-sqlite3

npm run dev
```

常用检查：

```bash
npm run typecheck
npm test
npm run build
```

## 独立轮次记录 CLI

`@scry/turn-recorder` 与 Electron App 共用 turn record、Trace 聚合和 Git Diff Core，但不依赖 Electron、SQLite 或 Provider SDK。它只在本地写 `.scry/`：

```bash
npm run pack:cli
npm install -g ./scry-turn-recorder-0.2.0.tgz
scry doctor --workspace /path/to/workspace
```

合同与接入约束见 [`docs/rfc/scry/turn-recorder-cli.md`](./docs/rfc/scry/turn-recorder-cli.md)。

## 技术栈

Electron、electron-vite、React 18、TypeScript、SQLite，以及各 Provider 的本地 CLI/SDK。

```text
Renderer (React)     对话、拓扑、分段、分析、诊断与右侧详情
       ↑ IPC
Preload              最小化暴露 window.scry API
       ↑ IPC
Main (Electron)      Provider adapters、会话、历史、账单、MCP、SQLite
       ↓
Local agent runtime  Claude / Codex / Qoder / OpenCode
```

## License

Scry 自有代码使用 [MIT License](./LICENSE)。第三方 SDK、CLI 与依赖仍受各自许可证或服务条款约束，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
