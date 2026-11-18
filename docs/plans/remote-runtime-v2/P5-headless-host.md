# P5 · 无界面执行端：登录时启动与宿主命令行批准（只设计）

状态：设计稿，不含实现。维护者 2026-11-18 决定分步做，与 P4 分开：

| 步 | 内容 | 本文 |
|---|---|---|
| 1 | 设置里的「登录时启动」：安装/卸载 launchd（macOS）或 `systemd --user`（Linux）服务，登录或重启后不开 App 也有后台服务；App 仍装在这台机器上 | §2 |
| 2 | 在执行端上用命令行批准新设备（方案 a）。能以同一 OS 用户登录这台机器的人，已经具备现有本机授权模型的权限（[§13.2](P3-batch4-design.md)）。方案 b（从已配对设备批准）不采用 | [P5-host-cli](P5-host-cli.md) |
| 3 | 不依赖 App 的独立安装包：P4 之后再做 | §8 |

命令行（§3）、安全分析（§4）、协议与版本（§5）在 [P5-host-cli](P5-host-cli.md)；本文的测试、拆分与决定覆盖两步。

## 1. 现状

### 1.1 后台服务怎么起来

| 环节 | 代码 | 事实 |
|---|---|---|
| 何时拉起 | `src/main/bootstrap/daemon-run-lazy.ts:9-12` | 打包版默认 daemon 模式（`daemon-mode-default.ts:6-9`），第一次需要时才拉起 |
| 探活→拉起→等待 | `src/main/daemon-supervisor.ts:44-69` | 先探活；没有才拉起；最多等 10 s；版本或构建号不同即 `version-mismatch`（71-82） |
| 拉起什么 | `src/main/bootstrap/daemon-launch.ts:16-27`、`72-77` | App 自己的 Electron 可执行文件（`process.execPath`）+ asar 内 `out/main/daemon-supervisor.js`，`detached`，输出追加到 `<userData>/logs/daemon.log`（0600，目录 0700） |
| 环境 | `src/daemon/supervisor.ts:81-120` | allowlist 转发 + `ELECTRON_RUN_AS_NODE=1` 与 `SCRY_DAEMON_*`；版本来自 `SCRY_DAEMON_APP_VERSION` |
| supervisor | `supervisor.ts:37-79`、`supervisor-main.ts:11-31` | 退出码 0 停、3 已有实例、2/4 确定性失败不重试；其余退避重启最多 4 次 |
| daemon | `src/daemon/main.ts:8-11`、`31`；`lifecycle.ts:78-137` | 同一 Electron 以 Node 模式运行；先拿 `daemon.lock` 再拿 `scry-userdata.lock` |
| 私有 CLI | `src/daemon/daemon-config.ts:38-40` | `<resources>/bin/scry` 绝对路径，不查 `PATH` |
| 服务模板 | `supervisor.ts:158-178` | 能生成 plist 与 unit，**不安装**，只有测试调用 |

### 1.2 App 退出、机器重启

- App 退出不停后台服务；「退出 Scry 与后台服务」与「重启后台服务」按 `daemon.lock` 身份复核后只发一次 SIGTERM（`src/main/background-service-actions.ts:56-109`，`background-service-stop.ts` 头注释）。
- 重启机器后没有任何东西拉起后台服务，直到有人打开 App。已配对设备在此期间连不上。
- 后台服务起来后：待完成的配对一律过期（`src/main/remote/pairing.ts:41-45`）；桌面访问端口按保存的设置恢复（`remote-host-service.ts` `#start`）；打包版默认连公共 relay（`remote-defaults.ts:11-15`）。所以**第 1 步单独就能让已配对设备在重启后恢复可用**。

### 1.3 远程访问、邀请与批准

| 动作 | 入口 | 实现 |
|---|---|---|
| 远程访问是否开启 | 环境变量 `SCRY_REMOTE_HOST`，打包版默认开 | `host-process.ts:345`；没有界面开关 |
| 手机邀请 | 设置页「生成配对码」→ `remote:pairing:begin` | `remote-host-service.ts:245-248`，`scry1:` 码只在 relay 可用时生成 |
| 桌面邀请（SSH） | 「启用并生成 SSH 邀请」→ `remote:desktop:invite` | `remote-host-service.ts:190-203`：需要时开两个 `127.0.0.1` 端口，返回 `scry-desktop1:` |
| 列出待确认 | `remote:status`（界面每 2 s 轮询，`RemotePairing.tsx:73`） | `remote-host-service.ts:307-325`，含完整公钥指纹 |
| 批准 | 点「确认」→ `remote:pairing:confirm(pairingId, 完整指纹)` | 界面显示前 16 位（`src/renderer/remote-pairing.ts:55-60`），提交整行的完整指纹（107-110）；authority 不符即拒（`pairing.ts:100-134`） |
| 取消 / 撤销 / 关桌面访问 | `remote:pairing:cancel` / `remote:device:revoke` / `remote:desktop:disable` | `pairing.ts:136-157`；撤销拒绝本机 App 自己的 grant（`pairing-channels.ts:42-46`） |

daemon 模式下这些通道经本机 op `localHostStatus`、`localPairing`、`localDesktopHost` 转给后台服务（`src/main/daemon-local-ops/pairing.ts:7-17`，`src/daemon/local-ops/pairing.ts:9-10`），用的是同一份 `pairingChannelHandlers`。其它规则：邀请 2 分钟有效（`pairing-state.ts:80`）；新邀请取消之前未完成的邀请（`pairing.ts:57-58`）；领取以宿主状态为准（[desktop-remote](../../desktop-remote.md)）。

### 1.4 今天离不开 App 界面的步骤

开机后拉起后台服务（第 1 步）；生成邀请（含开启桌面访问）、批准、取消、撤销（第 2 步）；版本不一致后重启后台服务（§2.4）。

### 1.5 现有代码与本设计冲突的地方

1. 模板把 `SCRY_DAEMON_APP_VERSION` 写死在服务文件里（`supervisor.ts:173-174`）。升级 App 后新代码会报旧版本，App 判为不一致，重启后还是旧版本，**永远对不上**。
2. unit 只转义 `\` 和 `"`（`supervisor.ts:154-156`），没处理 systemd 的 `%` 与 `$`；路径里有这两个字符会被展开。
3. 服务管理器给 supervisor 的是它自己的环境，不是 App 过滤后的环境。supervisor 只为 daemon 过滤（`supervisor.ts:96-120`），自己会吃到 `NODE_OPTIONS` 之类的变量。
4. App 自己的本机凭据用 Electron `safeStorage` 加密（`daemon-run-mode.ts:252-275`），Node 模式下的命令行用不了；本机只允许一个 local grant（`pairing.ts:202-204`）。命令行不能复用 App 的入网方式，见 [P5-host-cli](P5-host-cli.md) §3.3。

## 2. 第一步：登录时启动

### 2.1 服务文件

| 项 | macOS | Linux |
|---|---|---|
| 路径 | `~/Library/LaunchAgents/com.scry.daemon.plist` | `~/.config/systemd/user/scry-daemon.service`（按 `XDG_CONFIG_HOME`） |
| 程序 | `ProgramArguments` = [`process.execPath`, asar 内 `out/main/daemon-supervisor.js`] | `ExecStart=` 同上，逐项加引号 |
| 环境 | `ELECTRON_RUN_AS_NODE=1`、`SCRY_DAEMON_STATE_DIR`、`SCRY_DAEMON_USER_DATA_DIR`、`SCRY_DAEMON_ENTRY`、`SCRY_DAEMON_APP_PATH`、`SCRY_DAEMON_RESOURCES_PATH`、`SCRY_DAEMON_PACKAGED=1`、`SCRY_DAEMON_LAUNCHED_BY=service`；**不写版本** | 同左 |
| 清理继承变量 | `NODE_OPTIONS`、`NODE_PATH`、`NODE_EXTRA_CA_CERTS`、`NODE_TLS_REJECT_UNAUTHORIZED` 设为空串 | `UnsetEnvironment=` 同一组 |
| 启动 | `RunAtLoad=true`、`KeepAlive=false`、`LimitLoadToSessionType=Aqua`；不设 `ProcessType=Background`（会限流 Provider） | `WantedBy=default.target`、`Restart=no`、`KillMode=mixed`、`TimeoutStopSec=30` |
| 日志 | `StandardOutPath`/`StandardErrorPath` = `<userData>/logs/daemon.log` | `StandardOutput=append:` 同一文件 |
| 标记 | 注释行写入格式版本与 userData，用来识别「是我们的、属于哪个 userData」 | 同左 |

- 重启只由 supervisor 负责，确定性失败不会被服务管理器反复拉起。`KillMode=mixed` 只给 supervisor 发 SIGTERM，由 daemon 收尾 Provider 和终端。
- 版本：supervisor 从自身 bundle 取版本（构建期 define，与 `build-identity.ts` 的构建号同源），再传给 daemon；环境里另给的版本与之不同时以 exit 2 `daemon_config_version_conflict` 拒绝。
- 转义：systemd 值里 `%`→`%%`、`$`→`$$`；plist 走 XML 转义；路径含换行或其它控制字符时拒绝安装（`login_start_path_unsupported`）。空格、中文路径必须可用。

### 2.2 安装、卸载、状态

全部在 main 里做，renderer 只传一个布尔值。

- IPC：新通道 `remote:backgroundService:setLoginStart(enabled: boolean)`，`handleTrusted` 注册，照常校验 sender/frame/origin，参数必须恰好一个布尔值。状态并入现有 `remote:backgroundService:status` 的 App 侧字段 `loginStart`。两者都留在 main，不转给后台服务（矩阵记 main）。
- 服务文件的值只来自 main 的 `process.execPath`、`app.getAppPath()`、`process.resourcesPath`、`app.getPath('userData')`。
- 外部命令只用固定绝对路径与固定参数，不经 shell，10 s 超时：

| 动作 | macOS（`/bin/launchctl`） | Linux（`/usr/bin/systemctl --user`，找不到即 unavailable） |
|---|---|---|
| 开 | 原子写 plist → `bootstrap gui/<uid> <plist>` | 原子写 unit → `daemon-reload` → `enable` → `start` |
| 关 | 删 plist；后台服务没在跑时再 `bootout` | `disable` → 删 unit → `daemon-reload`；不 `stop` |
| 状态 | `print gui/<uid>/com.scry.daemon` | `is-enabled`、`show -p ActiveState,MainPID`；`/usr/bin/loginctl show-user <uid> -p Linger` |
| 由服务拉起 | `kickstart gui/<uid>/com.scry.daemon` | `start scry-daemon.service` |

- 开：已有后台服务在跑时，`RunAtLoad`/`start` 拉起的 supervisor 遇到 `daemon.lock` 以 3 退出、自己再以 0 退出，当前进程不受影响。状态显示「当前由 App 启动；下次登录起由系统服务启动」。
- 关：只取消下次登录启动，**不停当前后台服务**，不打断 run。
- 只在打包版、daemon 模式、非测试实例（`SCRY_TEST_APP`）下可用；其它情况显示 unavailable 并说明原因。

### 2.3 与 supervisor、两把锁、现有动作的关系

| 情形 | 行为 |
|---|---|
| 已安装服务，后台服务没在跑，App 打开 | App 改为经服务管理器拉起（上表最后一行），仍按 `ensureDaemon` 等 10 s；未安装时照旧 `spawnDaemonSupervisor` |
| 「重启后台服务」 | 不变：身份复核后 SIGTERM daemon；daemon 以 0 退出 → supervisor 以 0 退出 → 服务管理器不重启；然后按上一行拉起 |
| 「退出 Scry 与后台服务」 | 不变；下次登录或下次打开 App 再起 |
| 开关关闭的 App（`SCRY_HOST_DAEMON=0`） | 它持有 `scry-userdata.lock`（`role: app`），服务拉起的 daemon 以 exit 4 拒绝，supervisor 不重试（[P3-userdata-lock](P3-userdata-lock.md) 3b）；反过来走既有弹窗 |
| 另一个 userData 已装服务 | 标记里的 userData 不同 → 拒绝覆盖（`login_start_other_userdata`），显示对方路径 |

`daemon.lock` 与 userData 锁的身份核对不变：服务拉起的 daemon 命令行仍是同一个 asar 入口。daemon 自报新增 `launchedBy`（`app`/`service`/`unknown`），设置页据此说明谁拉起了当前进程。

### 2.4 升级、移动、删除 App

| 情形 | 结果 |
|---|---|
| 原地升级 | 路径不变；旧 daemon 跑到重启为止。打开 App → 现有不一致弹窗 → 重启 → 版本对上 |
| 无界面机器上升级（SSH 里 `pacman -Syu`） | 没有人打开 App；`scry-host` 与旧 daemon 版本不同，硬失败并给出重启命令（[P5-host-cli](P5-host-cli.md) §3.8）。旧进程按路径懒加载的文件（worker、私有 CLI）会读到新版本，属于既有风险，升级后应尽快重启 |
| App 被移动 | 打开 App 时发现服务文件指向别处：是我们的且 userData 相同 → 按当前路径重写并记日志；否则只显示状态，不动 |
| App 被删除、服务仍在 | 登录时找不到程序：macOS 记系统日志，Linux unit 为 failed（203/EXEC），都不重试。文档给出清理命令（`launchctl bootout gui/$(id -u)/com.scry.daemon`、`systemctl --user disable scry-daemon.service`，再删文件）。装回原路径即恢复 |

### 2.5 不得放宽的边界

- 启动环境清洗：服务文件清掉 Node 启动变量（§2.1），supervisor 仍按 allowlist 给 daemon 环境（`supervisor.ts:81-120`）；不把 `SCRY_REMOTE_*` 等诊断开关写进服务文件。
- 私有 CLI：daemon 仍用 `<resources>/bin/scry` 绝对路径（`daemon-config.ts:38-40`），不查 `PATH`。
- Provider 发现：照旧用登录 shell 补齐 `PATH` 等变量（`src/main/claude-locate.ts:166-167`）。服务环境里 `SHELL` 是否存在要实机确认；Linux 上不能落到 `/bin/zsh` 默认值了事，缺失时报告 unavailable 原因。
- 不加任何监听端口；桌面访问仍只在 `127.0.0.1`。

### 2.6 平台差异

- macOS：LaunchAgent 只在图形登录后加载（`Aqua`），只用 SSH 登录不会拉起；重启后要有人登录一次（是否开自动登录由用户决定）。
- 只做 `systemd --user`；没有 systemd 时显示 unavailable，不提供别的启动项（P3 §12 第 4 条建议）。
- **不自动开启 lingering。** 没开时，用户最后一个会话结束后服务停止。状态显示 `Linger=no` 及其后果，并给出 `loginctl enable-linger` 由用户自己执行。开了以后开机即启动，不需要登录。
- Arch/Hyprland：不改 `hyprland.conf`，不调用 `import-environment`，不依赖 `graphical-session.target`。
- 后台服务不需要密钥环；App 连接后台服务仍需要（既有 F2 规则不变）。

### 2.7 失败时用户看到什么

| 失败 | 设置页 |
|---|---|
| 写文件失败 / 命令非 0 / 超时 | 开关复原，显示机器码与说明；不留半写的文件 |
| macOS「登录项」里被关掉 | `bootstrap` 失败或状态为 disabled → 「已被系统设置禁止，请在 系统设置 → 通用 → 登录项 中允许」 |
| 服务存在但指向别的 App 或别的 userData | 显示路径，不覆盖 |
| supervisor 确定性失败 | 沿用 `supervisor-failure.json` 与现有原因文案 |
| 都拉不起 | 现有 `daemon_unavailable:<reason>` |

## 6. 测试与验证

| 层 | 内容 | 环境 |
|---|---|---|
| 单元 | 服务文件渲染：空格、中文、`%`、`$`、引号、控制字符拒绝；不含版本；清理变量在；命令序列与状态解析（注入的假执行器）；各 unavailable 情形 | 临时 HOME，CI |
| supervisor | 版本取自 bundle；环境版本冲突 exit 2 | CI |
| host-process | admin socket：token 错/缺/权限 0644、版本不一致、白名单外 method 全拒；经 admin socket 走完邀请→设备证明→错指纹被拒→对的通过→审计 `host_cli`；过期（假时钟）；撤销本机 grant 被拒 | 临时 userData，扩展 `host-process-pairing.test.ts` |
| 命令行 | node-pty 下交互通过，管道下 `invite`/`approve` 拒绝；指纹 <16 位、歧义拒绝；后台服务未运行 exit 2 且没有生成 `daemon.lock` | 临时 userData |
| IPC | `setLoginStart` 的 sender 与参数校验；preload 映射测试 | CI |
| 打包 smoke | 渲染服务文件到临时目录，用极简环境（`env -i HOME=… PATH=/usr/bin:/bin`）按其中的程序与参数启动 → 后台服务就绪、App 握手构建一致、`scry-host status` 可用；`check-packaged-app` 收录 `bin/scry-host` | L2 |
| 实机 macOS | 真 `launchctl`；重启后登录即可连；登录项通知与在系统设置里关闭；`~/Documents` 下项目的 TCC；Claude CLI 的钥匙串；`install:mac:dev` 升级后的不一致弹窗；移动、删除 App；命令行批准手机与桌面 | **需要维护者的 Mac** |
| 实机 Linux | Arch/Hyprland：`systemctl --user`；linger 开/关与注销；pacman 升级后命令行报不一致；日志 | **需要维护者的 Linux 机器** |

验证级别按 AGENTS「快速迭代」：L0 只跑相关测试与类型检查；L1 每个候选提交跑一次适用门禁；L2 用确切提交的候选包做 smoke；配对批准属门卫类改动，按批做 L3，含中文系统语言与中文工作区路径，记录 OS、locale、版本、是否正式包。缺环境标未验证，一端不代替另一端。

## 7. 拆分与顺序

| # | 内容 | 规模 | 依赖 |
|---|---|---|---|
| P5-0 | 修模板：不写版本、转义、清理变量、`KillMode`、`launchedBy`；supervisor 自取版本 | S | — |
| P5-1 | main 的登录时启动模块（渲染、执行器、状态）与测试 | M | P5-0 |
| P5-2 | 设置页开关、IPC、文案；装了服务时经服务管理器拉起 | M | P5-1 |
| P5-3 | 打包 smoke | S | P5-2 |
| P5-4 | 第 1 步实机验收 | — | P5-3；c35d0191 默认打开的真机验证先通过 |
| P5-5 | admin socket、token、白名单、审计 | M | — |
| P5-6 | `scry-host` 入口、wrapper、打包 allowlist | M | P5-5 |
| P5-7 | 设备列表显示批准方式 | S | P5-5 |
| P5-8 | 第 2 步实机验收（手机、桌面各一次） | — | P5-6 |

P5-0 到 P5-3 与 P5-5、P5-6 可以并行开发。**第 1 步在 c35d0191 的 macOS 真机验证通过之前不合入**：服务会让后台服务在没人打开 App 时自己起来，默认打开路径上的缺陷会变成每次登录都出现。

## 8. 不做 / 以后

- 不依赖 App 的独立安装包（P4 之后）。
- 从已配对设备批准（方案 b）。
- 系统级 LaunchDaemon、root、登录前运行；自动开启 linger；改 Hyprland 或任何全局配置。
- 非交互批准；命令行拉起或重启后台服务；终端里画二维码（以后可加）。
- macOS 用 `SMAppService`（Electron `app.setLoginItemSettings({ type: 'agentService' })`）：见决定 6。

## 9. 建议的术语（未改 GLOSSARY）

GLOSSARY 目前没有远程相关条目。建议在实现时补：**执行端**（被远程使用的那台机器；代码里叫 host/宿主）、**后台服务**（用户可见的 daemon 名称）、**登录时启动**、**设备**（经配对获得 grant 的另一台机器，不含本机 App）、**配对邀请**（`scry1:` / `scry-desktop1:`，2 分钟有效）、**待确认配对**、**宿主命令行**（`scry-host`）、**批准方式**（App / 命令行 / 未记录）。

## 10. 需要维护者决定

1. **命令行的认证方式。** 建议 `host-admin.sock` + 每次启动轮换的 0600 token（[P5-host-cli](P5-host-cli.md) §3.3）。另一种是给命令行单独的 grant scope，要存私钥文件（Node 模式没有 safeStorage）、占 64 条上限、改配对状态格式。
2. **入口名称与位置。** 建议独立的 `<resources>/bin/scry-host`，不放进 recorder CLI `scry`（[P5-host-cli](P5-host-cli.md) §3.1）。
3. **`invite`/`approve` 只允许交互。** 建议是；要给自动化留非交互批准，需单独再议。
4. **批准方式记在哪里。** 建议独立审计文件，grant 格式不动（[P5-host-cli](P5-host-cli.md) §3.7）。另一种是新 `source` 值：更直接，但旧版本读不了配对状态。
5. **装了服务后，App 一律经服务管理器拉起后台服务。** 建议是：拉起方只有一个，状态与日志一致；代价是 App 的启动路径按平台分叉。
6. **macOS 用 LaunchAgent plist 还是 `SMAppService`。** 建议先用 plist：与 Linux 对称，能在临时目录测试，不受签名状态限制。`SMAppService` 对升级更稳，但 plist 须静态打进 bundle，开发构建难验证。
7. **App 被移动后自动重写服务文件。** 建议只在「是我们的、同一 userData」时自动重写并记日志，其余情况只提示。
8. **配对记录 64 条上限。** 今天就不清理（[P5-host-cli](P5-host-cli.md) §3.3 末段）。建议第 2 步之前单独做一处小改动：只清理已取消、已过期、已拒绝的配对记录，保留 `paired` 记录（领取要用）；grant 不动。
