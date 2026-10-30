# Scry Linux / Omarchy 技术方案

状态：M1 产物与运行时适配已实施；M3/M4 的 Linux 实机验收未完成。
代码核查基线：`b7f1b43f`，App `0.2.227`。已在实施提交中落地第 3、4、5 节的代码改动。已有 Linux CI 配置与 CLI 支持，不等于当前桌面安装包已通过 Linux 验收。

### 实施状态（后续提交更新）

| 项目 | 状态 | 证据或阻碍 |
| --- | --- | --- |
| 私有 recorder 启动器支持两种布局 | 已实施 | 启动器测试覆盖 macOS/Linux 布局、软链接、含空格参数、缺可执行文件失败 |
| 产物布局、打包检查、smoke/soak 共用一套路径 | 已实施，一个例外 | 新 `scripts/packaged-app-layout.mjs` 供打包检查、security smoke、performance soak 共用；`scripts/desktop-remote-host-smoke.mjs` 已在文件体积预算上限之上，本次未改动，仍按 macOS 布局 |
| electron-builder Linux 配置 | 已实施 | 在 macOS 上交叉构建 `dist/linux-arm64-unpacked`，布局与 locale 裁剪已验证 |
| Linux locale 裁剪 | 已实施 | 配置为 `en-US/zh-CN/zh-TW` 时剩下三个 pak；去掉覆盖后 `locales/` 为空（反向对照） |
| 平台默认 shell | 已实施 | 启动时 `ensureShellEnv()` 补 SHELL（不覆盖用户值），终端与 `defaultShellPath` 同源；Linux 不再回退 zsh |
| Linux 密钥环 `basic_text` 拒绝 | 已实施 | `unsafeCredentialStorageReason` + 单测；未在真实密钥环状态验证 |
| 快捷键提示跟随平台 | 已实施 | renderer `platform.ts`；`保存 ⌘S`/`⌘↵` 改为平台值 |
| Linux CI 打包门禁 | 已实施，未跑过 | `.github/workflows/ci.yml` 的 `packaged-linux` job 尚未在 Linux runner 实际执行 |
| Linux 真实运行、原生模块、pacman 包生成 | 已在本地 Linux 容器验证 | 见 [本地验证记录](linux-omarchy-local-verification.md) |
| Wayland、中文输入、真实密钥环、真实 Provider | 未验证 | 需目标机 |

## 1. 目标与范围

让 Scry 在 Omarchy 上完成真实的本地 Agent 工作流，同时保持 macOS 行为。后续新增或修改业务功能只维护一套代码，不建立 Linux 分支产品。

建议第一版支持范围：

| 项目 | 建议目标 | 证据边界 |
| --- | --- | --- |
| 系统 | Omarchy / Arch Linux，x86_64 | 实施前确认用户版本和 CPU 架构 |
| 桌面 | Hyprland，原生 Wayland | 必须在目标桌面实测，Xvfb 不代替 |
| 分发 | Arch 原生安装包，由 pacman 管理 | 先验证打包链路和安装依赖，再固定包布局 |
| Provider | 保持现有 adapter，优先验收用户日常使用的 Provider | 每个 Provider 单列结果，不承诺能力一致 |
| 业务 | 会话、执行、审批、停止、历史、Git、终端、用量和 recorder | 不以界面可启动替代记录与恢复闭环 |
| macOS | 继续使用同一版本、共享业务代码 | 保留现有打包、安全和 UI 门禁 |

暂不做：Windows、Linux ARM64、Flatpak/Snap、AUR 发布、自动更新、跨机器历史迁移、自动修改 Hyprland 配置。AppImage 在出现跨发行版便携分发需求后再评估；不为第一版同时引入 FUSE、挂载路径和另一套安装验收。

远程连接涉及的 Linux 凭据存储属于本次安全适配范围。手机与多主机完整端到端验收另列，不能因为本地工作流通过而标记通过。

## 2. 核心决策：共享业务，隔离系统差异

```text
同一仓库 / 同一 App 版本 / 同一业务合同
  │
  ├─ 共享 React UI、状态与文案
  ├─ 共享 typed preload API、IPC 授权
  ├─ 共享会话、Provider adapter、Git、trace、持久化
  ├─ 共享 recorder core 与独立 CLI（不含桌面平台逻辑）
  │
  ├─ 运行时系统差异：窗口、按键、环境、安全存储
  └─ 构建系统差异：目录布局、原生模块、安装、签名
       ├─ macOS .app
       └─ Linux Arch 包
```

### 2.1 哪些代码不分叉

- 不复制聊天页面、会话 store、Provider adapter、数据库 schema 或 recorder 状态机。
- 不建立 `ChatViewLinux`、`LinuxProviderRegistry` 或两套业务 IPC。
- Linux 与 macOS 使用同一业务数据格式；路径解析遵循当前宿主的真实路径，不意味着可直接复制数据库和绝对路径跨机恢复。
- Provider 差异继续由现有 adapter 和 capability envelope 表达。操作系统差异不能抹平 Provider 的审批、resume、MCP 或 usage 合同。
- recorder core 继续无 Electron、SQLite、Provider SDK 与原生依赖。平台打包知识不进入 core。

### 2.2 差异放在哪里

| 差异 | 优先复用位置 | 实现原则 |
| --- | --- | --- |
| 窗口装饰、生命周期 | `src/main/window-chrome.ts`、`src/main/bootstrap/window.ts`、`src/main/bootstrap/app-lifecycle.ts` | 保留现有平台分支，不另造窗口管理器 |
| CLI 发现与环境 | `src/main/claude-locate.ts` | 共用发现链路，只修正平台相关默认值与路径 |
| 终端、停止进程 | `src/main/terminal-manager.ts`、`src/main/process-diagnostics.ts` | 先实测现有 POSIX 实现；仅对证实的差异分支 |
| 安全存储 | `src/main/bootstrap/remote-connections.ts` | 在现有凭据存储边界检查后端，不新增泛用 secret 框架 |
| 快捷键与提示 | `src/renderer/main.tsx`、`src/renderer/constants/copy.ts` 及涉及的组件 | 复用现有平台标记；提示与事件处理一致，文案集中管理 |
| 私有 CLI 入口 | `build/scry-cli` | 同一启动器覆盖两种安装布局，或构建时生成对应入口；不复制 CLI 实现 |
| 包布局与检查 | `electron-builder.yml`、现有构建和 smoke 脚本 | 多个消费者确实需要时抽取小型布局 helper，不创建插件注册体系 |

平台标记只用于展示或在 main 中选择系统实现，不能成为 renderer 授权依据。没有真实第二种实现的地方，不预建接口、工厂和备用路径。

## 3. 已发现的适配点

以下为源码检查结果，不是 Linux 运行结果。

| 现状 | 影响 | 计划 |
| --- | --- | --- |
| `electron-builder.yml` 仅显式配置 mac 目标；构建 wrapper 使用 `--dir` | 缺少面向 Omarchy 的安装包交付流程 | 增加 Linux 目标，区分目录包验证与安装包生成 |
| `build/scry-cli` 固定启动 `Contents/MacOS/Scry` | Linux 私有 recorder 无法按该布局运行 | 按已验证的产物布局定位 Electron，可执行文件不从 PATH 猜测 |
| `scripts/check-packaged-app.mjs` 使用 `.app/Contents`、Darwin PTY 路径 | 当前产物检查不能证明 Linux 包完整 | 共用内容与安全断言，平台化资源和原生模块路径 |
| `scripts/electron-security-smoke.mjs` 存在 macOS 可执行文件布局假设 | Linux 无法直接沿用全部 smoke 入口 | 盘点所有调用方，共用真实 App 启动定位 |
| `warmShellEnv` 缺少 `SHELL` 时回退 `/bin/zsh` | Linux 桌面启动可能缺少该 shell | 使用适合支持平台的默认值，并测试未设置 SHELL 的情况 |
| 环境白名单已包含 Wayland、D-Bus、XDG 相关变量 | 不需要重写整个环境采集链路 | 验证启动器与终端启动的一致性，保留清洗边界 |
| `windowTitleBarOptions` 已区分 Darwin | 窗口已具备复用基础 | Linux 使用现有非 Darwin 路径，实测平铺与缩放 |
| UI 仍有 `⌘` 与 Mac 指代 | Linux 提示可能与操作不一致 | 只迁移本次涉及的文案与快捷键 |
| 远程凭据仅检查 `safeStorage.isEncryptionAvailable()` | Linux 弱保护后端可能被误当成安全存储 | 增加后端检查与拒绝路径 |
| CI 已有 Ubuntu coverage/shell/CLI 检查，packaged Electron job 在 macOS | 已有跨平台基础，但缺桌面产物证据 | 补 Linux 安装包与运行 smoke，不复制全部测试实现 |

## 4. 运行时设计

### 4.1 Provider 发现与桌面环境

沿用 `claude-locate.ts` 的环境采集、缓存、白名单和 executable 解析。不能为了让 Linux 找到命令，取消环境清洗或把所有 shell secret 注入全部 Provider。

验收必须同时覆盖：

- 从终端启动与从桌面应用启动器启动。
- 用户真实 shell、未设置 `SHELL`、shell 启动脚本报错。
- Omarchy 的 mise/shims、用户自定义 PATH、显式 Provider 路径。
- 带空格和中文的 workspace 与 executable 路径。
- 登录 shell 采集失败时明确显示现有降级信息，不把继承环境冒充完整环境。

应用环境和 Provider 子进程环境是两个时点。Wayland / 输入法初始化所需配置必须在 Electron 创建窗口前生效，不能指望后来采集的 Provider shell 环境修复桌面输入。

### 4.2 Wayland、输入法和桌面操作

先验证当前 Electron 版本在目标 Omarchy 会话下的默认行为，只为可复现问题增加必要启动参数，不照搬过期 Chromium flags。

- 验证 Fcitx 中文组合输入、候选框、回车确认；候选确认不能误发消息。
- 验证 100% / 分数缩放、多屏切换、平铺调整、弹层定位。
- 验证文本和图片剪贴板、文件拖入、目录选择、外部文件与 HTTP(S) 链接打开。
- 继续使用 Electron 原生 dialog、shell 等现有系统集成，不直接增加任意命令或路径 IPC。
- 使用稳定 `.desktop` ID、窗口标识和图标，不自动写用户 Hyprland 全局规则。
- 保留 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。不接受 `--no-sandbox`、默认禁用 GPU 或放宽 CSP 作为修复。
- 若特定环境需要 XWayland，作为明确选择且单独验收的兼容模式；不能悄悄切换并宣称 Wayland 已通过。

普通编辑快捷键使用平台对应的 Cmd / Ctrl，终端保留 Ctrl+C 中断、Ctrl+Shift+C 复制等终端语义，不全局替换所有按键。

### 4.3 安全存储

复用当前远程连接凭据持久化流程，保留无已存凭据时不主动初始化或解锁密钥环的行为。

Linux 凭据读写前检查加密可用性与实际选择的存储后端。`basic_text` 或不可用状态必须拒绝凭据持久化；错误不能被吞掉或退回明文。后端未知时不宣称已受安全存储保护。

密钥环不可用不阻断纯本地项目，但需要凭据的远程连接操作应显示具体阻碍。提示集中到现有文案模块；不新增无实际用途的系统诊断页面。

Omarchy 上游包含 GNOME Keyring / libsecret，并有默认 keyring 初始化逻辑，但组件存在不证明用户的 keyring 已解锁或具有密码保护。实测记录后端和可用状态，不读取、输出或上传凭据，不承诺抵御同一用户权限下的恶意进程。

### 4.4 终端、进程身份与证据

- 在 Linux 上运行真实 PTY 测试，覆盖 cwd、resize、Unicode、退出和 App 关闭清理。
- 验证 `/bin/ps` 参数、固定 locale 的启动时间解析及进程树停止；身份缺失或不匹配时拒绝发信号，不用模糊 `pkill`。
- 不新增一套 Linux trace 或 recorder。managed recorder 仍等待 Provider result、hook、diff 等证据收敛。
- SQLite、archive、`.scry` 分别读回验证，不把某一个写入成功视为全部成功。缺失工具、usage 或文件证据继续标记 unavailable / partial，不能记成 0。
- 仓库 trust/fingerprint、工作区路径授权和既有自动授权来源标记保持不变。Linux 支持不改变 `full_access` 的本机权限含义。

## 5. 构建与分发

### 5.1 产物与依赖

在 Linux 构建 Linux 产物，不从 Mac 交叉打包结果推断原生模块可用。第一阶段先生成并验证 unpacked 目录，再生成 Arch 包，最后验证安装后的文件布局。

- Electron、`better-sqlite3` 和 `node-pty` 按 lockfile 与目标 Electron ABI 构建；检查动态依赖、权限和实际加载。
- 继续保留 SDK、PTY、SQLite 的必要 asar unpack 与资源白名单；不把本机日志、配置、凭据或无用 Provider 二进制带入包。
- 私有 recorder 继续从 App resources 中的绝对路径调用，使用包内 Electron Node 模式，保留参数边界、退出码与符号链接处理。
- 安装包声明经实测确认的 Arch 运行时依赖。构建依赖不混入运行依赖，Provider CLI 仍由用户安装与配置。
- 根据目标系统验证 Chromium sandbox 的正常启用方式；若包权限或内核配置不满足，修复安装流程或明确阻碍，不关闭保护。
- 安装不自动运行 Provider、读取真实会话或修改仓库 trust。卸载不自动删除用户数据；升级不隐式重写 Provider 配置。
- 第一期不实现自动更新、系统服务或开机自启。更新通过安装新包完成，退出 Scry 后再更新，不操作用户正在运行的实例。

### 5.2 脚本组织

优先改造现有 `scripts/run-electron-builder.mjs`、`scripts/check-packaged-app.mjs` 和 smoke 入口，共用产物内容、安全断言与 fixture。macOS 签名、公证、安装规则保持平台专属。

确需新命令时，在实现阶段新增并同步文档；本文不把尚不存在的 Linux npm script 当成可执行入口。现有 `pack:artifact` 仍含待改造的 macOS 假设，不能直接作为 Linux 发布成功的证明。

App 与独立 CLI 保持现有分别版本化策略；Linux 与 macOS App 不另起版本线。

## 6. 实施与验收里程碑

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| M0：确认环境 | 记录 Omarchy、Hyprland、CPU、GPU、缩放、输入法、shell、Provider 和 keyring 状态 | 明确支持矩阵、设备访问方式和账号授权；不收集 secret |
| M1：打通产物 | Linux 布局、私有 CLI、native rebuild、目录包和 Arch 包 | 安装后的 App 加载 SQLite/PTY；私有 CLI 不依赖全局 recorder；macOS 包检查不退化 |
| M2：运行时适配 | 环境、按键、Wayland、凭据后端和进程行为 | focused 正反测试通过；目标环境中的问题有对应回归 |
| M3：工作流验证 | 隔离 App 的会话、工具、停止、重启、归档和 recorder | 文件、数据库、进程与 UI 证据一致；真实 Provider 另行标记 |
| M4：发布准备 | Linux CI、Omarchy 实机验收、安装/升级/卸载说明 | 发布门禁通过，列出已支持组合与未验证能力，不带阻塞级问题交付 |

里程碑按依赖推进；M1 成功不能提前宣称 Omarchy 日常可用。没有真实设备时可完成代码和通用 Linux 测试，但 M4 保持未完成。

## 7. 测试策略

### 7.1 分层证据

| 层级 | 核心检查 | 不证明什么 |
| --- | --- | --- |
| 共享 unit / contract | 路径、按键、环境合并、安全存储拒绝、身份校验 | 不证明真实安装或桌面行为 |
| Linux 原生进程与包 | PTY、SQLite、CLI argv/退出码、产物资源、安装后启动 | 不证明 Hyprland 输入法与焦点 |
| 隔离 Electron fixture | 生产 preload/main wrapper、会话/文件操作、恢复、renderer 隔离 | 不证明真实 Provider 接受请求 |
| Omarchy 前台实机 | Wayland、输入法、缩放、文件对话框、桌面入口、密钥环 | 不自动覆盖其他发行版或 GPU |
| 已授权真实 Provider | 一轮执行、工具、审批、停止、恢复、证据与费用来源 | 不把一个 Provider 的结果外推到其他 Provider |

关键反向验证至少包括：恢复 macOS-only 启动器时 Linux CLI 测试失败；强制弱存储后端时拒绝凭据写入；进程身份不匹配时不发信号。shell fixture 检查独立 argv，不用拼接后的字符串证明含空格参数正确。

测试使用临时 workspace、独立 HOME/配置与 userData；不写真实 `.scry`、transcript 或数据库。真实 Provider 探针必须获得账号/费用授权；手机操作如纳入后续范围，遵循仓库真机/iCTRL 规则。

### 7.2 复用现有门禁

实施时按实际影响选择并运行现有命令：`npm run test:unit -- <已定位的测试文件>`、`npm run typecheck`、`npm run build`、`npm run test:shell`。占位参数不是可直接复制的命令。

发布阶段按 [验证与交付](../agent/verification.md) 执行完整门禁，包含适配后的 `npm run pack:artifact`；保留 macOS `npm run test:renderer:ui`。Linux 增加同源 fixture 和安装包检查，不为了上线跳过现有失败。

涉及性能热路径时运行 `npm run performance:measure` 的相关场景。Linux 毫秒数据单列系统、硬件与负载，不与 Mac 混合基线，也不通过放宽 ratchet 让测试通过。计数与耗时结论分别报告。

### 7.3 必须完成的用户工作流

1. 从桌面入口打开，选择带空格/中文路径的临时 Git 项目，发现已安装 Provider。
2. 发送中文输入，完成一次真实文件修改；核对工具 trace、Git diff 和 `.scry` 记录。
3. 验证目标 Provider 支持的审批、拒绝和停止，不影响无关进程。
4. 关闭并重新打开 App，查看历史并恢复支持的会话；不自动重发未知结果请求。
5. 在内置终端交互、调整尺寸、切换项目并退出，核对进程收敛。
6. 验证文件预览、外部打开、目录选择与授权边界。
7. 若使用远程连接，验证可用/锁定/缺失 keyring 的行为及凭据读写，绝不回退弱存储。
8. 安装升级后核对原有数据仍可读；卸载后确认用户数据未被自动清除。

## 8. 后续功能开发规则

| 未来改动 | 实现方式 | 验证要求 |
| --- | --- | --- |
| 新会话功能、分析面板、聊天交互 | 修改同一业务模块和组件 | 共享测试，按交互风险做桌面回归 |
| Provider 协议或权限能力 | 修改对应 Provider adapter | Provider 合同测试；系统相关执行另验 |
| 快捷键、通知、密钥环 | 在现有边界增加必要平台分支 | 两个平台的行为与失败路径 |
| 原生依赖、私有 CLI、包布局 | 共用业务，分别构建产物 | 两个平台真实包检查与运行 smoke |

维护成本增加主要来自两套运行环境的验收，而不是两套功能实现。代码审查时检查新增平台判断是否位于正确边界、是否复制了可共享业务、是否把不可用伪装成成功。

## 9. 待确认项与责任

| 项目 | 负责人 | 下一步 |
| --- | --- | --- |
| 在真实 Omarchy 上跑 M2–M4 验收 | 用户与实施者 | 在目标机执行 `npm ci`、`npm run pack:artifact`、本文件第 7.3 节的 8 条工作流；结果按 Provider 分别记录 |
| pacman 安装依赖与包布局 | 实施者 | 用 M1 产物实际 `pacman -U`，核对依赖解析、`chrome-sandbox` 权限与 `.desktop` 入口 |
| 首批 Provider | 用户 | 指定日常使用对象及是否授权真实账号/费用验证 |
| 目标机访问与前台验收 | 用户与实施者 | 确定 SSH/本机协作方式；SSH 不等于 GUI 验收已具备 |
| Linux CI 首次运行 | 实施者 | 观察 `packaged-linux` job 首轮结果；失败时修 fixture，不放宽检查 |

## 10. 参考与限制

- 仓库合同：[CLAUDE.md](../../CLAUDE.md)、[架构与地图](../agent/architecture.md)、[验证与交付](../agent/verification.md)。
- [Electron 42.10.1 safeStorage 合同](https://github.com/electron/electron/blob/v42.10.1/docs/api/safe-storage.md)：Linux `basic_text` 使用固定明文口令，不能当成安全 secret store。
- [Omarchy 上游](https://github.com/omacom/omarchy)：前期核查的默认分支为 `quattro`；包清单、UWSM/mise、Fcitx 与 keyring 配置只作为集成线索，不代表用户安装版本。

本地 Linux 容器验证结果见 [本地验证记录](linux-omarchy-local-verification.md)。仍未验证：Wayland/Hyprland 交互、中文输入、真实密钥环与真实 Provider 请求，这些只能在目标机确认。
