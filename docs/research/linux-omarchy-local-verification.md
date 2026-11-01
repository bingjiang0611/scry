# Scry Linux 本地验证记录

记录在 macOS 上通过 colima 启动的 Linux VM（aarch64, Ubuntu 24.04 容器）对 Scry 做的实际验证。目的是补上"没有 Linux 主机就无法验证"的部分，不替代目标 Omarchy 机器验收。

基线：提交 `1fc5a0b2` 之后的改动（含本记录的 smoke 适配），App `0.2.227`，Electron `42.10.1`。
环境：macOS 27.2 (arm64) → colima (Virtualization.Framework) → Ubuntu 24.04 aarch64 容器，6 CPU / 12 GiB，Node `v22.23.4`。

## 环境搭建

容器内除 `npm ci` 外还需要：`build-essential`/`python3`（node-pty、better-sqlite3 源码构建）、Electron 运行库（gtk3、nss、libnotify、libxtst、libxss、at-spi2-core、libsecret、alsa）、`xvfb`、`libarchive-tools`（pacman 包需要 `bsdtar`）、`pacman-package-manager`（校验产物）。仓库复制到无空格路径 `/work/scry`，因为 node-gyp 在含空格的路径上不稳定。

## 结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `npm ci` | 通过 | 665 包；node-pty `build/Release/pty.node`、better-sqlite3 `build/Release/better_sqlite3.node` 均为 Linux aarch64 |
| `npm run typecheck` | 通过 | node + web 两套 tsc |
| `npx vitest run` | 4353 通过 / 5 失败 → 全部为环境 | 失败原因：`chrome-sandbox` 未 setuid、缺 `.git`（counter 测试）、缺 X server（2 个 Electron fixture）；按 CI 同样做法修复后全部通过 |
| 单独确认 5 个失败项 | 通过 | `chown root:root` + `chmod 4755 chrome-sandbox`；`git init` 造 HEAD；`xvfb-run` 提供 DISPLAY |
| `npm run build` + `build:cli` | 通过 | electron-vite 与 recorder CLI 均产出 |
| `electron-builder install-app-deps` | 通过 | better-sqlite3 / node-pty 按 Electron ABI 重建 |
| `scripts/run-electron-builder.mjs`（`--dir`） | 通过 | `dist/linux-arm64-unpacked`：`scry` 可执行文件 + `resources/` + `locales/` |
| `npm run check:packaged-app` | 通过 | `platform: linux`，`nodePty: true`，locale 三项齐全，资源 allowlist 通过，`scryCliVersion: 0.2.52` |
| 私有 recorder CLI | 通过 | `resources/bin/scry --version` 在当时的 Linux aarch64 容器中真实执行（走 `<root>/scry` 分支）；这是已验证项，不代表当前集成版本或 Arch/Omarchy x86_64 验收 |
| pacman 包生成（`SCRY_RELEASE_BUILD=1`） | 通过 | `dist/scry-0.2.227-aarch64.pacman`，84.7 MB，423 条目，安装到 `/opt/Scry` |
| `.PKGINFO` | 通过 | `pkgname/pkgver/arch/depend` 正确，8 个 Arch 依赖按配置写入，`pkgdesc` 单行（见下方修复记录） |
| `pacman -Qip` 读取产物 | 通过 | pacman 6.0.2 读出完整描述、版本、架构、依赖 |
| `pacman -U` 安装到假根 | 归档与解包通过 | 完整性（含 `.MTREE`）校验通过、文件正确落到 `/opt/Scry` 与 `/usr/share/applications`；`post_install` 脚本因假根无 shell 未执行，属环境限制 |
| 打包 App 完整 security smoke（xvfb） | 通过 | 见下表 |
| `npm run check:pacman-package` | 通过 | 产物契约检查；去掉描述覆盖后同一条检查失败（反向对照） |
| macOS 回归（同版本 smoke） | 通过 | `chrome: macos`，macOS 集成标题栏断言全部保留 |

### 打包 App smoke 覆盖范围（Linux, xvfb）

通过项：preload 边界（122 keys）、popup/navigation 拒绝、子 frame 无特权 IPC、工具输出分页与外来内容拒绝、内置终端（PTY 真实启动）、renderer 重载后终端接管与陈旧 owner 围栏、终端录制（录制/回放/只读/删除/不重启 shell）、历史重载与崩溃后恢复、右侧工作区各标签与终端保留、模态框焦点与 Esc 恢复。

## 本轮修正的 macOS 假设

`scripts/electron-security-window-boundary.mjs` 原来把 macOS 集成标题栏当成唯一事实（platform 必须 `macos`、应用列必须贴顶、品牌栏 52px、红绿灯安全区 80px、`-webkit-app-region`）。Linux 窗口由窗口管理器加框，这些结构不存在。现在：

- 平台标记按宿主断言（`macos` / `linux`）。
- 贴顶、52px、80px 安全区、app-region 一组断言只在 macOS 执行。
- "已最大化"在 Linux 只断言状态位已提交，并把实测几何作为证据输出。
- 把 `surfaceLeft` 的比较改回未取整值：`Math.round(15.5) = 16` 会在 macOS 上制造假的 1px 失败（该断言语义是"距左边缘 < 16px"）。

## 本轮修掉的两个问题

### 1. pacman `pkgdesc` 为空（已修）

成因：electron-builder 对非 rpm 目标固定把描述拼成 `"${synopsis}\n ${description}"` 传给 fpm，而 pacman 的 `.PKGINFO` 是逐行 `key = value`，第二行让 `pkgdesc` 解析成空值，`pacman -Qi` 显示 `Description: None`。包本身仍可安装，所以只能靠读 `.PKGINFO` 发现。

修法：在 `pacman.fpm` 里透传单行 `--description`。fpm 的参数在文件映射前追加，重复的 `--description` 以最后一个为准，端口只影响 pacman 目标，不碰 deb/rpm 语义，也不需要改写归档或 `.MTREE`。

验证：

| 检查 | 结果 |
| --- | --- |
| `pkgdesc` 单行、非空、内容正确 | 通过（`pacman -Qip` 显示完整描述） |
| `.PKGINFO` 依赖 8 项、`pkgver`、`arch`、`packager` | 通过 |
| `.PKGINFO`/`.INSTALL`/`.MTREE`/`opt/Scry/scry`/`resources/bin/scry`/`scry.desktop` | 通过 |
| `.INSTALL` 的 `bash -n` 语法、含 `chrome-sandbox` 权限处理 | 通过 |
| 反向对照：去掉 `pacman.fpm` 后重打包 | `check:pacman-package` 失败，报 `pkgdesc is empty` |

新增 `scripts/check-pacman-package.mjs`（`npm run check:pacman-package`），并接进 Linux CI job，跟 `check:packaged-app` 一起跑。

### 2. 右侧工作区最大化后"没铺到左侧"（不是产品缺陷）

现场：`.app` 网格 `0px 8px 1271px`、`.main-area` 已隐藏、slot `grid-column: 3`、宽度 1271px，但 `getBoundingClientRect().left` 是 759（视口 1279）。

定位：同一次采样里 `slot.offsetLeft = 8`，而 `rect.left = 759`，差 751px 正好等于入场动画 `translateX(751px)`；三个 Web Animation 都是 `playState: running`、`pending: true`、`currentTime: 0`，两秒后仍不动。也就是说 Xvfb 没有合成器帧，动画起始时间永不提交，pane 停在动画首帧。布局本身是对的。

修法在测试侧：断言改用去掉 transform 后的布局盒左边（`rect.left - translateX`），不再依赖动画完成；macOS 的红绿灯安全区（80px）等断言仍只在 macOS 执行。

验证：Linux 与 macOS 都不再按平台分支，"最大化后工作区铺到侧栏折叠位置"作为共享断言执行，两边通过。这条同时说明：在 Xvfb 里跑任何依赖入场动画结束的断言都不可靠。

### 3. `desktopName` / `StartupWMClass` 关联（已修，Wayland `app_id` 已实测）

electron-builder 警告未设置 `desktopName`。查上游实现：`.desktop` 的 `StartupWMClass` 取 `package.json` 的 `desktopName`，缺省回退到 `productName`（这里是 `Scry`）；`syncDesktopName: true` 让 `.desktop` 文件名也用同一个值。

实测方式：容器内用 `sway`（wlroots headless 后端）起真实 Wayland 合成器，`--ozone-platform=wayland` 启动打包 App，再用 `swaymsg -t get_tree` 读窗口的 `app_id`。

| 配置 | `.desktop` 的 `StartupWMClass` | 实测 Wayland `app_id` |
| --- | --- | --- |
| 无 `desktopName`、无 `syncDesktopName` | `Scry` | `scry` |
| `desktopName: scry.desktop` + `syncDesktopName: true` | `scry` | `scry` |

结论：Electron 42 的 `app_id` 一直是 `scry`（来自可执行文件名），真正不一致的是 `StartupWMClass=Scry` 的大小写。改成同值后三者一致（文件名、`StartupWMClass`、`app_id`）。X11 侧 `WM_CLASS` 两种配置完全相同（`xprop` 实测 `("scry" "scry")`），所以这个改动只影响关联键，不改变窗口行为。

`check:pacman-package` 现在会校验 `desktopName`、`.desktop` 文件名、`StartupWMClass` 三者一致；去掉 `desktopName` 重打包会让它失败。

## 仍未解决

1. **Hyprland 上的窗口关联、输入法、分数缩放、真实密钥环、pacman 真实安装、真实 Provider**：本轮只在 headless wlroots 上验过 `app_id`，Hyprland 与输入法、缩放必须上目标机验证。
2. **`scripts/desktop-remote-host-smoke.mjs`** 仍按 macOS 布局取可执行文件，且该文件已超过仓库 2 万字节提交预算，未改动；因此 `npm run pack:artifact` 的 GUI smoke 部分在 Linux 上不能整套跑通。
3. 包体积：Linux 解包后 330.3 MB（预算 346.0 MB），只剩约 15 MB 余量，接近上限。

## 复现前置与历史限制

原验证使用过特权容器并挂载宿主用户目录。这不是安全隔离：容器内的仓库代码、安装脚本和依赖可以访问或修改挂载的日常数据。本文保留历史结果，但移除这套不安全的一键启动命令；不要照此运行不可信代码。原环境还调整过 VM 内核的 user namespace 策略和 `chrome-sandbox` 所属者、权限，这些条件不能当作普通 Linux 宿主的默认配置。

后续由验证负责人准备独立、可销毁的 Linux 环境，使用专用临时 workspace、HOME 和 userData，不挂载日常用户目录，不默认赋予容器特权。依赖与构建入口见[安装指南](../linux-getting-started.md)和 CI 的 `packaged-linux` job；Ubuntu 使用 `build-essential`，不要照抄 Arch 的 `base-devel`。Chromium sandbox 无法正常启用时报告阻碍，不关闭保护或自动修改日常宿主策略。

复测 Wayland `app_id` 时，须先以有界就绪检查确认当前合成器实例的 socket 和 `swaymsg` 可用，再启动冻结的 App 产物并读回窗口信息。不得在后台启动后立即取第一个 socket，也不能用固定延迟冒充就绪；保留该实例的 PID、socket、退出状态和原始输出。

上述受限环境与自动就绪流程尚未重放，因此这里不提供未经验证的替代容器或 Sway 启动脚本，也不把它们标记为通过。目标 Arch/Omarchy 验收仍由第 9 节责任表中的用户与实施者完成，见[技术方案](linux-omarchy-technical-plan.md#9-待确认项与责任)。
