# Scry

Scry 是一个本地优先的 AI coding agent 观测与治理桌面应用。它在应用内驱动本机 agent CLI，把终端里的执行过程呈现为可检查的对话、工具调用、文件足迹、会话纵览、用量与诊断信息。

> 当前状态：**MVP / WIP**。项目主要在 macOS 上开发和验证，暂不提供已签名、公证的安装包。Linux（Arch/Omarchy）的代码与打包路径已适配，Linux 桌面行为尚未在真实 Omarchy 机器上验收。

## 能做什么

- 在桌面界面中启动和停止 agent turn，流式查看模型输出与工具调用。
- 按工作目录管理新会话、历史会话和最近项目。
- 汇总 token、cost、duration、tool/MCP 调用与文件读写足迹。
- 提供对话、会话纵览、账单卫士、MCP 信任、跨会话分析和诊断视图。
- 通过 Provider adapter 接入 Claude、Codex、Qoder、OpenCode 和 Pi；各 Provider 的可用能力取决于本机 CLI/SDK 与登录状态。
- 提供独立的 `scry-turn-recorder` CLI，在本地记录顶层 agent turn。

## 安全与数据边界

> **重要：Scry 不是安全沙箱。** 各 Provider 默认使用自身的审批或 workspace sandbox；只有用户显式选择“完全访问”时，Claude 和 Qoder 才使用 `bypassPermissions` / `dangerously-skip-permissions`，其他 Provider 采用各自等价的完全访问模式。Agent 仍可能在获批或完全访问时读取、修改文件并执行命令，不保证被限制在所选工作目录内。只在你信任的代码库和可恢复环境中使用。

- **采集输出默认保留原文，不脱敏。** 工具入参/输出、对话、trace、用量原始 payload、远程输出及其归档可能包含密钥、令牌、Cookie 和私钥；本机备份、导出、已授权远程设备和 commit hook 也可能获得这些内容。分享或上传前请自行检查。
- Scry 的会话索引、观测数据和 turn-recorder 记录保存在本机；turn-recorder 默认只写工作区的 `.scry/`，不实现上传。历史已脱敏记录不恢复；诊断包、认证错误和凭据配置展示仍保留防泄露处理。终端输出默认原文录制到 App `userData/terminal-recordings/`；Shell 退出后可在当前标签页回放或删除录制；关闭标签页或重启 App 后，可从「终端录制历史」按当前工作区分页查找并只读打开。历史回放不会恢复旧 Shell 或执行命令。清屏、关闭标签页不会删除磁盘记录，暂不自动清理。录制失败会提示，磁盘未确认的尾部不会被标为完整。
- Scry 本身没有项目数据上传后端，但 Provider CLI/SDK 会连接各自服务；其数据处理遵循对应 Provider 的配置、许可证和服务条款。
- Bash、MCP 和第三方工具可能访问 Scry 无法完整统计的文件或网络资源，文件足迹不是安全沙箱或完整审计日志。
- 项目级 MCP、Hook、plugin 和 recorder commit callback 默认自动授权执行，不显示确认弹窗；Scry 仍在 Provider 启动边界重新校验配置、内容指纹与 executable SHA-256，并将 recorder 自动授权标为 `source=auto`。打开不可信仓库可能直接触发本机代码执行；该校验不承诺抵御已经能以同一 macOS 用户身份修改进程或文件的并发攻击者。
- 逐工具审批的覆盖范围取决于 Provider 与 transport；即使界面出现审批，也不能把 Scry 当作统一的权限隔离层。

## Provider 状态

| Provider | 接入方式 | 状态 |
| --- | --- | --- |
| Claude | Claude Agent SDK / 本机 Claude Code | 主要开发路径 |
| Codex | 本机 Codex app-server | 实验性 |
| Qoder | Qoder Agent SDK | 实验性 |
| OpenCode | OpenCode SDK / server | 实验性 |
| Pi | 本机 Pi JSONL RPC / 可配置 pi-agent Profile | 实验性；支持模型、Skill 与命令；Pi 未提供 MCP 状态 API，Scry 不探测 |

## 开发环境

前置要求：

- macOS（当前主要开发与验证平台）或 Linux（首批 Linux 目标是 Arch/Omarchy，尚未完成实机验收）
- Node.js 22.12 或更高版本（桌面 App 工具链；独立 recorder CLI 另支持 Node 20/22/24）
- 至少一个已安装并完成登录的受支持 agent CLI

```bash
nvm use 22
npm ci
npm run hooks:install

# 如果 Electron 二进制没有完整下载
node node_modules/electron/install.js

# better-sqlite3 需要针对当前 Electron ABI 重建时
./node_modules/.bin/electron-rebuild -f -w better-sqlite3

npm run dev
```

Linux（Arch/Omarchy）构建需要同样的 Node.js 版本，另需 `base-devel`、`python`（node-pty、better-sqlite3 编译）与 `fpm` 所需工具链：

```bash
npm ci
npm run build && npm run build:cli
npm run pack:artifact        # 只出 dist/linux-unpacked 并跑产物检查
SCRY_RELEASE_BUILD=1 npm run pack   # 产出可安装的 pacman 包
sudo pacman -U dist/scry-*.pacman
```

Linux 的分发包不关闭 Chromium sandbox，也不自动修改 Hyprland 配置。首次运行前请确认密钥环可用（远程连接凭据需要 GNOME Keyring / libsecret）；否则凭据保存会被拒绝而不是退回明文后端。

### Git 提交文件大小检查

`npm run hooks:install` 为当前仓库安装 pre-commit hook，不修改全局 Git 配置。每个新检出需执行一次；不会随 `npm ci` 自动安装。已有其他 hook 会通过符号链接保留；若已有 pre-commit，安装器拒绝覆盖，需先人工整合。

- 只检查新增、修改、复制或重命名文件的**完整暂存版本**，不读取工作区版本；删除项不检查。
- 超过 **20,000 字节**则拒绝提交，即按 `bytes / 4` 估算超过 5,000 tokens；这不是真实 tokenizer 计数。已有大文件修改后同样受限。
- 排除锁文件（`package-lock.json`、`npm-shrinkwrap.json`、`yarn.lock`、`pnpm-lock.yaml`、`Package.resolved`）、PNG/ICNS 资源、符号链接及子模块。生成代码仅排除 `experiments/remote-g0/generated/wire.mjs`、同目录 `wire.ts` 和 `experiments/remote-g0/swift/Sources/RemoteTransport/Wire.swift`。新增生成物类型需审查并更新脚本中的明确列表，不按作者身份猜测，也不豁免整个 `generated/` 目录。
- 报错会列出文件、字节数和估算 tokens。按职责提取组件、领域逻辑或测试套件，更新引用并验证后重新暂存；不要为凑大小机械切片或增加空包装层。

可用 `npm run check:staged-file-size` 手动运行。hook 依赖 `PATH` 中的 Node.js；本地 Git hook 可被 `--no-verify` 跳过，不是安全边界或服务端门禁。安装时保留的其他 hook 列表不会自动发现上游新 hook；需要更新时，先恢复安装前的 `core.hooksPath`、删除 Git 目录内的 `scry-hooks`，再重新安装。

- **修改后验证**：修改代码后需要验证 App 行为时，应启动基于当前代码、使用独立 `userData` 和临时工作区的 test 实例进行验证，不要求用户重启当前 App，也不停止或干扰用户正在使用的实例。

常用检查：

```bash
npm run typecheck
npm test                 # Vitest 单测/合同测试 + workspace Hook shell 测试
npm run build
npm run check:cli-release # CLI 单测、构建、npm tarball 干净安装与 bin/doctor smoke
```

GitHub Actions 会在 Node 22 运行 App 的 typecheck、全量测试与构建，在 Node 20/22/24
运行 CLI 发布检查，并在 macOS Node 22 打包后执行 packaged App 与 Electron security smoke。
Linux 打包门禁在 ubuntu 上验证产物布局、原生模块、私有 CLI 与 locale 裁剪；GUI smoke 与 Wayland 行为仍在目标机验收。

## 独立轮次记录 CLI

`scry-turn-recorder` 与 Electron App 共用 turn record、Trace 聚合和 Git Diff Core，但不依赖 Electron、SQLite 或 Provider SDK。它只在本地写 `.scry/`：

桌面 App 已自带同源 CLI，并固定通过 App Resources 内的绝对路径驱动 Provider/Hook；安装或更新 App 时会同步更新其私有 CLI，不依赖用户 `PATH` 中的全局版本。下面的 npm 安装仅用于没有桌面 App 的 headless/独立终端环境。

```bash
npm install -g scry-turn-recorder@0.2.51
scry doctor --workspace /path/to/workspace
```

CLI 支持 Node.js 20、22、24，运行平台为 macOS / Linux。Windows 原生当前不在支持范围；
默认 daemon 使用 Unix socket，rate-native 的 Hook/uploader 也依赖 Unix shell。

独立 npm 安装默认不执行后台更新；可用 `scry upgrade --check` 检查、`scry upgrade` 明确升级。
需要后台检查兼容更新时显式设置 `SCRY_AUTO_UPDATE=1`；后台任务只检查、不安装，升级仍需前台运行
`scry upgrade`。可再用 `SCRY_NO_UPDATE_CHECK=1` 或 `--no-update-check` 临时禁用检查。App 私有 CLI、Hook、daemon 与 CI 不参与自动更新。

若 npm 的系统全局目录不可写，可安装到用户目录，并确保 `~/.local/bin` 在 `PATH`：

```bash
npm install -g --prefix "$HOME/.local" scry-turn-recorder@0.2.51
export PATH="$HOME/.local/bin:$PATH"
```

维护者发布前运行 `npm run publish:cli`。该命令会通过 package lifecycle 强制执行
typecheck、tests、CLI build，再发布到本机 npm 配置（或 `--registry`）指定的 registry；不要从陈旧 `dist` 手工发布。

合同与接入约束见 [`packages/turn-recorder-cli/README.md`](./packages/turn-recorder-cli/README.md) 及 `src/shared/turn-record.ts`。

## 技术栈

Electron、electron-vite、React 18、TypeScript、SQLite，以及各 Provider 的本地 CLI/SDK。

```text
Renderer (React)     对话、分析、诊断与右侧会话纵览
       ↑ IPC
Preload              最小化暴露 window.scry API
       ↑ IPC
Main (Electron)      Provider adapters、会话、历史、账单、MCP、SQLite
       ↓
Local agent runtime  Claude / Codex / Qoder / OpenCode
```

## License

Scry 自有代码使用 [MIT License](./LICENSE)。第三方 SDK、CLI 与依赖仍受各自许可证或服务条款约束，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
