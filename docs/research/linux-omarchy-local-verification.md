# Scry Linux 本地验证记录

记录在 macOS 上通过 colima 启动的 Linux VM（aarch64, Ubuntu 24.04 容器）对 Scry 做的实际验证。目的是补上"没有 Linux 主机就无法验证"的部分，不替代目标 Omarchy 机器验收。

基线：提交 `1fc5a0b2` 之后的改动（含本记录的 smoke 适配），App `0.2.227`，Electron `42.10.1`。
环境：macOS 27.2 (arm64) → colima (Virtualization.Framework) → Ubuntu 24.04 aarch64 容器，6 CPU / 12 GiB，Node `v22.23.4`。

## 环境搭建

容器内除 `npm ci` 外还需要：`base-devel`/`g++`/`make`/`python3`（node-pty、better-sqlite3 源码构建）、Electron 运行库（gtk3、nss、libnotify、libxtst、libxss、at-spi2-core、libsecret、alsa）、`xvfb`、`libarchive-tools`（pacman 包需要 `bsdtar`）、`pacman-package-manager`（校验产物）。仓库复制到无空格路径 `/work/scry`，因为 node-gyp 在含空格的路径上不稳定。

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
| 私有 recorder CLI | 通过 | `resources/bin/scry --version` 在 Linux 上真实执行（走 `<root>/scry` 分支）——这是本次最关键的未验证项 |
| pacman 包生成（`SCRY_RELEASE_BUILD=1`） | 通过 | `dist/scry-0.2.227-aarch64.pacman`，84.7 MB，423 条目，安装到 `/opt/Scry` |
| `.PKGINFO` | 通过（一处缺陷） | `pkgname/pkgver/arch/depend` 正确，8 个 Arch 依赖按配置写入；`pkgdesc` 见下方已知问题 |
| `pacman -Qip` 读取产物 | 通过 | pacman 6.0.2 正常解析版本、架构、依赖 |
| `pacman -U` 安装到假根 | 归档与解包通过 | 完整性（含 `.MTREE`）校验通过、文件正确落到 `/opt/Scry` 与 `/usr/share/applications`；`post_install` 脚本因假根无 shell 未执行，属环境限制 |
| 打包 App 完整 security smoke（xvfb） | 通过 | 见下表 |
| macOS 回归（同版本 smoke） | 通过 | `chrome: macos`，macOS 集成标题栏断言全部保留 |

### 打包 App smoke 覆盖范围（Linux, xvfb）

通过项：preload 边界（122 keys）、popup/navigation 拒绝、子 frame 无特权 IPC、工具输出分页与外来内容拒绝、内置终端（PTY 真实启动）、renderer 重载后终端接管与陈旧 owner 围栏、终端录制（录制/回放/只读/删除/不重启 shell）、历史重载与崩溃后恢复、右侧工作区各标签与终端保留、模态框焦点与 Esc 恢复。

## 本轮修正的 macOS 假设

`scripts/electron-security-window-boundary.mjs` 原来把 macOS 集成标题栏当成唯一事实（platform 必须 `macos`、应用列必须贴顶、品牌栏 52px、红绿灯安全区 80px、`-webkit-app-region`）。Linux 窗口由窗口管理器加框，这些结构不存在。现在：

- 平台标记按宿主断言（`macos` / `linux`）。
- 贴顶、52px、80px 安全区、app-region 一组断言只在 macOS 执行。
- "已最大化"在 Linux 只断言状态位已提交，并把实测几何作为证据输出。
- 把 `surfaceLeft` 的比较改回未取整值：`Math.round(15.5) = 16` 会在 macOS 上制造假的 1px 失败（该断言语义是"距左边缘 < 16px"）。

## 已知问题与未解决项

1. **pacman `pkgdesc` 为空。** electron-builder 对非 rpm 目标固定传 `"${synopsis}\n ${description}"`，而 pacman 的 `.PKGINFO` 要求 `pkgdesc` 单行。结果是 `pacman -Qi` 显示 `Description: None`（包本身可解析、可安装）。需要在包内修正或等上游修复，尚未处理。
2. **右侧工作区最大化后的几何在 Linux 上异常。** 实测：`.app` 网格为 `0px 8px 1271px`、`.main-area` 已 `display:none`、slot `grid-column: 3`、宽度 1271px，但 slot 左边界为 759px（视口 1279px），即面板没有铺到左侧，而是留在右侧约 520px 宽。原因未定位，需要在目标机看一次截图确认是否复现。
3. **Wayland、输入法、分数缩放、真实密钥环、pacman 真实安装、真实 Provider**：本轮完全未覆盖，只有在 Omarchy 上才能验证。
4. **`scripts/desktop-remote-host-smoke.mjs`** 仍按 macOS 布局取可执行文件，且该文件已超过仓库 2 万字节提交预算，未改动；因此 `npm run pack:artifact` 的 GUI smoke 部分在 Linux 上不能整套跑通，CI 的 Linux job 只做打包与产物检查。
5. 包体积：Linux 解包后 330.3 MB（预算 346.0 MB），只剩约 15 MB 余量，接近上限。

## 复现方式

```bash
colima start --cpu 6 --memory 12 --disk 60
docker run -d --name scry-linux --privileged -v "$HOME":"$HOME" ubuntu:24.04 sleep infinity
# 安装 node 22、base-devel/python3、Electron 运行库、xvfb、libarchive-tools、pacman-package-manager
# 仓库复制到 /work/scry（无空格路径），然后：
npm ci
npm run typecheck
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' npx vitest run
npm run build && npm run build:cli
./node_modules/.bin/electron-builder install-app-deps
node scripts/run-electron-builder.mjs && npm run check:packaged-app
SCRY_RELEASE_BUILD=1 node scripts/run-electron-builder.mjs
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' node scripts/electron-security-smoke.mjs
```

容器需要 `chmod 4755` + root 所属的 `chrome-sandbox`（与 CI 相同做法），并允许非特权 user namespace（`sysctl kernel.apparmor_restrict_unprivileged_userns=0`），否则 Chromium 会拒绝启动。这不代表产品层面放宽 sandbox。
