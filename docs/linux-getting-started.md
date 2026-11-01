# Linux 安装与首次使用

面向 Arch Linux / Omarchy **x86_64**、Hyprland / Wayland。Scry 与 macOS 共用代码，不是安全沙箱。

> 支持状态：Linux 构建、pacman 元数据、私有 CLI、隔离 App smoke 已在 Ubuntu aarch64 容器验证；Wayland 窗口标识已在 headless wlroots 检查。**尚未完成 Omarchy x86_64 实机验收**，这也不代表承诺支持 Linux ARM64。本文的目标机安装、输入法、缩放与真实 Provider 步骤仍需实测。历史证据见 [本地验证记录](research/linux-omarchy-local-verification.md)。

## 1. 准备环境

- 使用普通用户登录桌面，不用 root 启动 Scry。
- 安装至少一个受支持的 Provider CLI，并按它的官方说明完成登录。Claude 是主要路径；Codex、Qoder、OpenCode、Pi 是实验性路径，能力不完全相同。
- Scry 不附带 Provider 账号、订阅或额度。发送真实请求可能产生费用。
- 仅打开可信仓库。项目 MCP、Hook、plugin 和 recorder commit callback 默认自动授权，虽会重验指纹，仍可能以本机用户权限执行代码；目录选择和审批都不等于安全隔离。

先确认机器架构：

```bash
uname -m
```

本指南的目标输出为 `x86_64`。不能把在 Apple Silicon 容器生成的 `aarch64.pacman` 包装到 x86_64 机器上，也不要用忽略架构或依赖的选项强装。

## 2. 获取安装包

### 已有维护者提供的 pacman 包

确认来源可信、版本和架构符合目标机器，然后直接进入第 3 节。目前不承诺每个版本都有可下载的 Linux 包，也没有 AUR、Flatpak 或 Snap 安装流程。

### 从源码构建

需要 Node.js **22.12 或更高版本**及 npm；推荐使用仓库 CI 的 Node 22。若已用 mise/nvm 管理版本，先在当前终端激活对应版本，不要再叠装另一套。未安装且不使用版本管理器时，可通过 Arch 官方仓库安装（仓库版本可能高于 Node 22）：

```bash
sudo pacman -S --needed nodejs npm
```

确认实际版本：

```bash
node --version
npm --version
```

在 Arch/Omarchy 上安装构建依赖（这是系统级操作，请先阅读 pacman 的事务确认）：

```bash
sudo pacman -S --needed git base-devel python libarchive
```

`libarchive` 提供 `bsdtar`，用于生成和检查 pacman 归档。安装阶段由 pacman 解析 GTK、NSS、libsecret 等运行依赖；仅在解包目录运行时，则需要自行准备这些库，依赖清单见仓库根 `electron-builder.yml` 的 `pacman.depends`。

获取源码，确认检出的版本**包含 Linux 适配**；不要假定尚未推送或合入的本地提交已在默认分支上：

```bash
git clone https://github.com/bingjiang0611/scry.git
cd scry
git log -1 --oneline
```

若需要测试尚未发布的版本，使用维护者提供的分支/提交或源码副本。不在有未保存改动的工作区盲目切换版本。

以下命令均在仓库根执行，不要加 `sudo`。依赖安装和打包需要访问 npm、Electron 等下载源：

```bash
npm ci
./node_modules/.bin/electron-builder install-app-deps
npm run typecheck
npm run build
npm run build:cli
SCRY_RELEASE_BUILD=1 node scripts/run-electron-builder.mjs
npm run check:packaged-app
npm run check:pacman-package
```

成功后，`dist/` 内应有 `.pacman` 安装包及 Linux 解包目录。检查实际文件名，不依赖本文中的固定版本号：

```bash
find dist -maxdepth 1 -type f -name '*.pacman' -print
```

- `check:packaged-app` 检查布局、原生模块、资源、locale 和私有 CLI；`check:pacman-package` 检查包描述、依赖和桌面入口。它们不证明完整桌面交互可用。
- 当前不要用 `npm run pack` 或 `npm run pack:artifact` 代替上述 Linux 流程：它们包含仍依赖 macOS 布局的远程宿主 smoke。详细限制见 [Linux 验证与交付](agent/verification.md#linux-验证与交付)。
- `SCRY_RELEASE_BUILD=1` 在这里选择生成 pacman 包，不代表产物已签名或通过目标机验收。

## 3. 检查并安装

把下面变量改成**本次生成或取得的单个包**的绝对路径，不要使用会匹配多个旧版本的通配符：

```bash
PACKAGE='/绝对路径/scry-版本-x86_64.pacman'
pacman -Qip "$PACKAGE"
pacman -Qlp "$PACKAGE"
```

确认名称为 `scry`、架构为 `x86_64`、版本正确、Description 非空；清单应包含 `/opt/Scry/scry` 和 `/usr/share/applications/scry.desktop`。确认来源与内容后再安装：

```bash
sudo pacman -U "$PACKAGE"
pacman -Qi scry
```

缺少依赖时先处理 pacman 报错，不用 `--nodeps` 或 `--overwrite '*'` 绕过。安装成功只证明包管理事务完成，下一步还要检查启动与使用。

## 4. 启动 Scry

从桌面启动器搜索 **Scry**。也可以在已登录的桌面终端中运行：

```bash
/opt/Scry/scry
```

若要明确检查原生 Wayland，在有效的 Wayland 桌面会话中、退出已有 Scry 后运行：

```bash
/opt/Scry/scry --ozone-platform=wayland
```

这个参数不会创建 Wayland 会话；普通 SSH 或无显示环境的终端不能因此显示窗口。暂不自动修改 Hyprland 全局配置或 `.desktop` 参数。确认目标机工作正常后再决定自己的启动方式。

**注意命令重名**：桌面包与独立 npm recorder CLI 都可能占用 `scry` 命令。`type -a scry` 可查看当前解析结果；启动桌面 App 使用上面的绝对路径最明确。桌面 App 已带私有 recorder CLI，不需要再全局 npm 安装它。

## 5. 完成第一次会话

1. **先检查 Provider。** 例如在同一用户的终端运行 `command -v claude`、`claude --version`，再按 Provider 官方流程确认登录可用。这里只确认安装/登录，不要用真实请求测试额度，除非你愿意承担费用。
2. **新建会话。** 在 Scry 左侧点击「新建会话」。在工作目录选择入口点击「选择文件夹」，选择一个可信、可恢复的项目；第一次建议用临时 Git 项目。检查显示的路径是否正确。
3. **选择 Agent 与模型。** 在输入区的 Agent 选择器中选已安装的 Provider。若列表为空或刚安装过 CLI，点击「重新扫描 PATH」。不要把「设置 → 外观」当成 Provider 登录入口；各 Provider 的认证以自己的 CLI/配置为准。
4. **确认审批方式。** 首次使用保留 Provider 默认审批语义。不要为了排错直接切换「完全访问」；它不是更强的沙箱，具体效果随 Provider 而异。选择目录不会自动发送任务。
5. **发送第一条请求。** 先用小任务，例如“说明这个项目的目录结构，不修改文件”。检查选中的工作目录、模型和审批方式，再点击发送。请求文本不是权限边界，仍需观察实际工具行为。
6. **查看证据。** 观察流式输出和工具调用。缺失的 token、成本、文件或风险信息代表不可观测，不等于零或无风险。需要修改文件时先确认 Git 状态，结束后审阅实际 diff。
7. **需要中止时点击停止。** 等待明确终态。显示「停止待确认」或结果未知时，不要假定进程已结束，也不要反复发送同一任务。新建会话不等于停止旧会话。
8. **检查历史与终端。** 从侧栏重新打开会话；退出再启动后核对历史能读取。需要时打开「右侧工作区」中的终端，确认实际目录与 shell。不要在首次试用中运行破坏性命令。

Linux 的快捷键提示使用 Ctrl；请按当前界面提示操作，不照搬 macOS 的 ⌘。快捷键、输入法与缩放仍需目标桌面确认。

## 6. 远程连接与密钥环

只使用本地项目时不必为了远程凭据先配置密钥环。使用远程连接时，需要可用且已解锁的 Secret Service（例如 GNOME Keyring）及对应桌面会话环境。

Scry 会拒绝 Linux `basic_text` 明文后端；即使 Electron 报加密 API 可用，也不把该后端视为安全。保存失败时检查当前桌面会话的密钥环与 D-Bus，不用 `--password-store=basic` 绕过。安装 `libsecret` 库本身不等于密钥环服务已启动、解锁。

远程功能另见 [桌面远程访问](desktop-remote.md)；本指南不声称真实 Linux 密钥环已验收。

## 7. 升级、备份和卸载

### 升级

1. 等待或明确停止正在运行的任务，退出 Scry。
2. 备份应用数据和重要项目；升级前不要删除旧数据。源码构建者按第 2 节为新版本重新生成和检查产物。
3. 对**新版本的确切包路径**执行 `sudo pacman -U "$PACKAGE"`。
4. 重新启动，核对版本、历史与 Provider 可用性。安装不会把仍在运行的旧进程变成新版本。

目前没有桌面 Linux 自动更新流程。不要把独立 recorder 的 `scry upgrade` 当成桌面 App 升级。

### 数据备份

应用数据使用 Electron 的 `userData` 目录；Linux 通常位于 `${XDG_CONFIG_HOME:-$HOME/.config}` 下的应用子目录，名称与启动版本/参数有关。可用数据库定位实际目录：

```bash
find "${XDG_CONFIG_HOME:-$HOME/.config}" -maxdepth 2 -type f -name scry.db -print
```

若没有结果，不代表没有数据：尚未创建数据库或自定义过 `--user-data-dir` 时，需要核对实际启动配置。完全退出后备份**整个实际 userData 目录**，不要只复制 `scry.db`；会话索引、归档等也可能在该目录。项目内的 `.scry/` 和各 Provider 自己的会话/配置需要分别备份。备份可能含敏感内容，不要公开上传。加密凭据的文件备份不保证能在另一台机器解密。

### 卸载

退出 App，确认没有仍需保留的运行任务，然后执行：

```bash
sudo pacman -R scry
```

这会卸载系统包，不自动删除项目、项目内 `.scry/`、Provider 数据或用户的 Scry 数据。不要把递归删除用户目录作为常规卸载步骤。卸载后可用 `pacman -Q scry` 确认包已不存在；用户数据保留情况仍需目标机核对。

## 8. 常见问题

| 现象 | 下一步 |
| --- | --- |
| 缺少 Electron 可执行文件 | 源码构建目录中执行 `node node_modules/electron/install.js`，成功后继续原构建流程；检查下载源/网络，不用复制别的平台二进制 |
| node-pty / SQLite 的 ABI 或架构错误 | 在目标 Linux 机器重新 `npm ci` 并执行 `electron-builder install-app-deps`；不要复用 macOS 的 `node_modules` 或解包产物 |
| `bsdtar` 找不到 | 安装 Arch 的 `libarchive` 或 Ubuntu 的 `libarchive-tools` 后重试失败的构建步骤 |
| 找不到运行库 | 检查 `pacman -Qi scry` 和报错所指依赖；优先使用安装包而不是直接运行缺少依赖的解包目录 |
| sandbox / user namespace 错误 | 保留错误输出，检查安装完整性和系统 user namespace / sandbox 策略；不要 root 运行、不加 `--no-sandbox`，不照搬容器里的 sysctl 修改 |
| `Missing X server` / Wayland 连接失败 | 在真实桌面会话运行，检查 `DISPLAY` / `WAYLAND_DISPLAY`；原生 Wayland 可按第 4 节显式启动，不把无显示环境当作 App 崩溃 |
| Provider 在终端可用，App 找不到 | 比较桌面会话与终端的 PATH；激活正确的 Node/CLI 环境后从终端启动 Scry，再「重新扫描 PATH」。不要以 root 安装/登录另一个账号来替代当前用户配置 |
| 窗口没有正确合并到启动器条目 | 核对安装包版本与 `scry.desktop`，其 `StartupWMClass` 应为 `scry`；检查是否有自己创建的旧桌面入口，不直接覆盖 Hyprland 配置 |
| 中文输入或分数缩放异常 | 记录 Omarchy/Hyprland、输入法、缩放比例、启动参数及 X11/Wayland 模式；这些尚待目标机验收，不默认禁用 GPU 掩盖问题 |
| 凭据保存被拒绝 | 按第 6 节检查已解锁的密钥环；不降级明文 |

反馈问题时附上 App/包版本、CPU 架构、桌面环境、启动方式、最小操作步骤和错误片段。可从桌面终端用 `/opt/Scry/scry` 观察 stderr；先移除令牌、会话内容、项目路径等敏感信息。不要上传完整 userData 或真实 Provider transcript。

## 9. 目标机首次验收清单

以下是**待执行清单，不是通过记录**：

- [ ] pacman 安装成功，包版本/架构/描述正确。
- [ ] 桌面入口可启动，窗口与启动器条目关联正确。
- [ ] 中文输入、缩放、窗口最大化/恢复可用。
- [ ] 能发现已登录的 Provider，第一条请求成功；账号与费用由使用者确认。
- [ ] 在临时项目中修改文件、查看 diff、审批和停止符合预期。
- [ ] 终端工作目录正确，重启后会话历史可读。
- [ ] 若使用远程连接，凭据可安全保存；密钥环不可用时明确拒绝。
- [ ] 升级后数据可读；卸载不删除用户项目与用户数据。

开发维护规则见 [跨平台检查清单](agent/change-checklists.md#macos--linux-跨平台改动)。
