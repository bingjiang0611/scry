# P5 · 无界面执行端：登录时启动与宿主命令行批准（只设计）

状态：设计稿；P5-0 已实现（[P5-host-security](P5-host-security.md) §7），其余未实现。维护者 2026-11-18 决定分步做，与 P4 分开；同日评审意见全部按推荐采纳（见文末「评审后修订」）。

| 步 | 内容 | 文档 |
|---|---|---|
| 1 | 设置里的「登录时启动」：安装/卸载 launchd（macOS）或 `systemd --user`（Linux）服务，登录或重启后不开 App 也有后台服务；App 仍装在这台机器上 | 本文 §2 |
| 2 | 在执行端上用命令行批准新设备（方案 a）。默认关闭，须在 App 设置里打开「允许命令行批准」 | [P5-host-cli](P5-host-cli.md) §3、§5 |
| 3 | 不依赖 App 的独立安装包：P4 之后再做 | [P5-host-security](P5-host-security.md) §8 |

安全分析与缓解（§4）、测试（§6）、拆分与顺序（§7）、不做（§8）、术语（§9）在 [P5-host-security](P5-host-security.md)；决定（§10）在本文末。

## 1. 现状

### 1.1 后台服务怎么起来

| 环节 | 代码 | 事实 |
|---|---|---|
| 何时拉起 | `src/main/bootstrap/daemon-run-lazy.ts:9-12` | 打包版默认 daemon 模式（`daemon-mode-default.ts:6-9`），第一次需要时才拉起 |
| 探活→拉起→等待 | `src/main/daemon-supervisor.ts:40-69` | 先探活；没有才拉起；最多等 10 s（`DAEMON_READY_TIMEOUT_MS`）；版本或构建号不同即 `version-mismatch` |
| 拉起什么 | `src/main/bootstrap/daemon-launch.ts:16-27`、`72-77` | `process.execPath` + asar 内 `out/main/daemon-supervisor.js`，`detached`；日志目录 0700、`daemon.log` 0600 追加（65-67） |
| 环境 | `src/daemon/supervisor.ts:81-120` | allowlist 转发 + `ELECTRON_RUN_AS_NODE=1` 与 `SCRY_DAEMON_*`；`STARTED_BY` 由调用方定（`supervisor-main.ts:25` 写 `supervisor:<pid>`） |
| 配置 | `src/daemon/daemon-config.ts:12-23` | supervisor（`supervisor-main.ts:6`）与 daemon 都要求 `SCRY_DAEMON_APP_VERSION`，缺即 exit 2 |
| 停止 | `supervisor-main.ts:15`、`32`；`supervisor.ts:140-141` | SIGTERM 只 abort；子进程的 AbortError 立即按 `{code:0}` 结算，**不等 daemon 退出**，随后 `process.exit(0)` |
| daemon 收尾 | `src/daemon/host-process.ts:387-399`；`lifecycle.ts:87-90` | 终端录制收尾、远程服务释放，最后放两把锁；`signal-shutdown.ts:8-13` 只跑一次 |
| 私有 CLI | `daemon-config.ts:38-40` | `<resources>/bin/scry` 绝对路径，不查 `PATH` |
| 服务模板 | `supervisor.ts:158-178` | 能生成 plist 与 unit，**不安装**，只有测试调用 |

### 1.2 App 退出、机器重启

- App 退出不停后台服务；「退出 Scry 与后台服务」「重启后台服务」按 `daemon.lock` 身份复核后只发一次 SIGTERM（`background-service-actions.ts:56-109`，`background-service-stop.ts:10-20`），有 run 时先原生确认（63、93）。重启机器后没有东西拉起后台服务，直到有人打开 App。
- 后台服务起来后：待完成的配对一律过期（`pairing.ts:41-45`）；桌面访问端口按设置恢复；打包版默认连公共 relay（`remote-defaults.ts:11-15`）。所以**第 1 步单独就能让已配对设备在重启后恢复可用**。

### 1.3 远程访问、邀请与批准

| 动作 | 入口 | 实现 |
|---|---|---|
| 远程访问是否开启 | 环境变量 `SCRY_REMOTE_HOST`，打包版默认开 | `host-process.ts:345`；没有界面开关 |
| 邀请 | `remote:pairing:begin` / `remote:desktop:invite` | `remote-host-service.ts:245-248`（`scry1:`，需 relay）/ `190-203`（`scry-desktop1:`） |
| 列出待确认 | `remote:status`（界面每 2 s 轮询） | `remote-host-service.ts:307-325`，含完整指纹 |
| 批准 | `remote:pairing:confirm(pairingId, 完整指纹)` | 界面显示前 16 位（`src/renderer/remote-pairing.ts:55-60`）；authority 不符即拒（`pairing.ts:100-134`） |
| 取消 / 撤销 / 关桌面访问 | `cancel` / `revoke` / `desktop:disable` | `pairing.ts:136-157`；撤销拒绝本机 App 的 grant（`pairing-channels.ts:42-46`） |

daemon 模式下这些通道经本机 op 转给后台服务（`src/main/daemon-local-ops/pairing.ts:7-17`），用同一份 `pairingChannelHandlers`。邀请 2 分钟有效（`pairing-state.ts:80`）；新邀请取消之前未完成的（`pairing.ts:57-58`）。

### 1.4 远程策略今天从哪来

以下变量由 App 环境经 supervisor 转给 daemon（`supervisor.ts:84-86`），是**策略，不是诊断开关**：

| 变量 | 作用 | 读取处 |
|---|---|---|
| `SCRY_REMOTE_HOST` | 远程访问开/关 | `host-process.ts:345`，`remote-defaults.ts:11-15` |
| `SCRY_REMOTE_PERMISSION_MODE` | 远程 run 的权限模式覆盖 | `host-process.ts:228-231` |
| `SCRY_REMOTE_RELAY_ENABLED` | `0` 时只走 SSH，不拨 relay | `bootstrap/remote-relay.ts:34`，`docs/desktop-remote.md:203` |
| `SCRY_REMOTE_RELAY_WS` | 自定义 relay，**含 token** | `remote-relay.ts:36-51` |
| `SCRY_DISABLED_PROVIDERS` | 禁用 Provider | `bootstrap/provider-runtime.ts:64`，`providers/registry.ts:71-85` |
| `SCRY_RUN_CONTROLS`、`SCRY_PROVIDER_MANIFEST_URL` | 关运行控制、换 Provider 清单来源 | `provider-runtime.ts:57-65` |

`SCRY_REMOTE_RELAY_SSH` 在 allowlist 里，但 `src` 中没有读取方。旧的 `SCRY_REMOTE_RELAY`（`remote-relay.ts:57`）不在 allowlist，daemon 模式本就忽略它。

### 1.5 现有代码与本设计冲突的地方

1. 模板写死 `SCRY_DAEMON_APP_VERSION`（`supervisor.ts:173-174`），升级后永远对不上；不写又过不了 `supervisor-main.ts:6` 的配置读取。
2. unit 只转义 `\` 和 `"`（`supervisor.ts:154-156`），没处理 `%` 与 `$`。
3. 服务管理器给 supervisor 的是它自己的环境；supervisor 只为 daemon 过滤（`supervisor.ts:96-120`）。
4. `SHELL` 只在 App 里补（`bootstrap/app-lifecycle.ts:51`）；daemon 没有，`claude-locate.ts:166` 落到 `/bin/zsh`。
5. 停止时不等 daemon（§1.1）：服务管理器在 supervisor 退出后清理剩余进程，daemon 收尾被截断。
6. `safeStorage`（`daemon-run-mode.ts:252-275`）在 Node 模式不可用；本机只允许一个 local grant（`pairing.ts:202-204`）。

## 2. 第一步：登录时启动

### 2.1 服务文件

| 项 | macOS | Linux |
|---|---|---|
| 路径 | `~/Library/LaunchAgents/com.scry.daemon.plist` | `~/.config/systemd/user/scry-daemon.service`（按 `XDG_CONFIG_HOME`） |
| 程序 | `ProgramArguments` = [`process.execPath`, asar 内 `out/main/daemon-supervisor.js`] | `ExecStart=` 同上，逐项加引号 |
| 固定环境 | `ELECTRON_RUN_AS_NODE=1`、`SCRY_DAEMON_STATE_DIR`、`_USER_DATA_DIR`、`_ENTRY`、`_APP_PATH`、`_RESOURCES_PATH`、`_PACKAGED=1`、`SCRY_DAEMON_LAUNCHED_BY=service`；**不写版本** | 同左 |
| 策略环境 | §2.2 | 同左 |
| 清掉 | `NODE_OPTIONS`、`NODE_PATH`、`NODE_EXTRA_CA_CERTS`、`NODE_TLS_REJECT_UNAUTHORIZED`、`NODE_REDIRECT_WARNINGS`、`NODE_V8_COVERAGE`、`DYLD_INSERT_LIBRARIES`、`DYLD_LIBRARY_PATH`、`DYLD_FRAMEWORK_PATH`、`DYLD_FALLBACK_LIBRARY_PATH` 设为空串 | `UnsetEnvironment=` 同一组 Node 变量 + `LD_PRELOAD`、`LD_LIBRARY_PATH` |
| 重启 | `RunAtLoad=true`、`KeepAlive={Crashed=true}`、`LimitLoadToSessionType=Aqua` | `Restart=on-abnormal` |
| 停止 | `ExitTimeOut=30` | `KillMode=mixed`、`TimeoutStopSec=30` |
| 其它 | `AssociatedBundleIdentifiers` = App 的 bundle id（登录项里显示为 Scry）；`ProcessType` 见下 | `WantedBy=default.target` |
| 日志 | `StandardOutPath`/`StandardErrorPath` = `<userData>/logs/daemon.log` | `StandardOutput=append:`、`StandardError=append:` 同一文件 |

- **停止要等 daemon。** P5-0 改 `launchDaemonOnce`：abort 后不在 AbortError 处结算，等子进程 `exit`，最多 25 s；超时记 `daemon_stop_timeout` 并以非 0 退出。25 s 小于两边的 30 s，daemon 的 dispose 能跑完。launchd 若也把 SIGTERM 发给整个进程组，daemon 收到两次，`signal-shutdown.ts` 只处理一次。
- 重启只在异常死亡时：supervisor 自己以 0/1 退出不重启；被崩溃信号杀死才由服务管理器拉起。两边的确切语义要实机确认（§6）。
- 版本：supervisor 从自身 bundle 取版本（构建期 define，与 `build-identity.ts` 同源），只把它传给 daemon；环境里另给的版本不同即 exit 2 `daemon_config_version_conflict`。`readDaemonProcessConfig` 拆成 supervisor 用（不要求版本）与 daemon 用两份。
- `launchedBy`：supervisor 读自己环境里的 `SCRY_DAEMON_LAUNCHED_BY`（只收 `app`/`service`），作为 `daemonLaunchEnvironment` 的显式参数传下去；不进 `FORWARDED_ENV`，不改 `STARTED_BY`。App 拉起时传 `app`。
- `SHELL`：supervisor 与 daemon 入口都先调 `ensureShellEnv()`（`src/main/shell.ts:11-13`，无 Electron 依赖）。
- 日志：开启时先建 `<userData>/logs`（0700）与 `daemon.log`（0600），同 `daemon-launch.ts:65-67`；不在 unit 里设 `UMask`。日志不轮转，与 App 拉起时相同。
- 转义：systemd 值里 `%`→`%%`；`$`→`$$` 只在 `ExecStart=`（`Environment=` 与 `append:` 不展开 `$`，systemd 255 实测）；plist 走 XML 转义；含换行或其它控制字符的路径拒绝（`login_start_path_unsupported`）。空格、中文路径必须可用。
- `ProcessType`：先实测不设与 `Interactive` 两种下的首 token 时延与 CPU，再定。不设 `Background`（会限流 Provider）。

### 2.2 远程策略随服务写入

服务拉起的 daemon 拿不到 App 的环境。开启时按 App 当前环境处理 §1.4 的变量：

| 变量 | 开启时 |
|---|---|
| `SCRY_REMOTE_HOST`、`SCRY_REMOTE_PERMISSION_MODE`、`SCRY_REMOTE_RELAY_ENABLED`、`SCRY_DISABLED_PROVIDERS`、`SCRY_RUN_CONTROLS`、`SCRY_PROVIDER_MANIFEST_URL` | App 环境里有就写进服务文件；先按各自读取方的规则校验，非法即拒绝 |
| `SCRY_REMOTE_RELAY_WS` | 带 token，不写进明文服务文件：**拒绝开启**（`login_start_secret_env`），说明原因与做法（去掉该变量，或不用登录时启动） |
| `SCRY_REMOTE_RELAY_SSH` | 没有读取方；P5-0 从 allowlist 删除，不写，也不因它拒绝 |
| `SCRY_DAEMON_SMOKE_PROVIDER`、`SCRY_RUN_TIMING` | 验收与测量用，不写 |

- daemon 自报有效远程配置（远程访问、relay 方式、权限模式覆盖、禁用的 Provider）。App 采用一个 `launchedBy=service` 的后台服务时，与自己环境推出的值比较，不一致就在设置页和 run 路径上提示，不静默。
- 写入的是开启那一刻的快照；改环境后要关掉再开。设置页显示写入了哪些。
- 以后：把这些策略挪进持久化设置，服务文件只留固定环境（§8）。

### 2.3 登录时启动模块

模块放在无 Electron 依赖的位置（如 `src/daemon/login-start/`），由 main 与宿主命令行共用：渲染、识别、执行器、状态。

- 输入只有四个值：可执行文件、asar、resources、userData。main 取自 `process.execPath`、`app.getAppPath()`、`process.resourcesPath`、`app.getPath('userData')`；命令行按 bundle 布局推出，测试保证两边渲染逐字节相同。
- App 入口：新通道 `remote:backgroundService:setLoginStart(enabled: boolean)`，`handleTrusted`，照常校验 sender/frame/origin，参数恰好一个布尔值；状态并入 `remote:backgroundService:status` 的 `loginStart`。都留在 main（矩阵记 main）。
- **开启前原生确认**（main 里，同 `background-service-actions.ts:63`、`93` 的做法）：说明这会装一个随登录常驻、可被已配对设备远程访问的服务。关闭不确认。
- 命令行入口：`scry-host login-start enable|disable|status`（[P5-host-cli](P5-host-cli.md) §3.10）。开启同样要确认；它**不会**打开「允许命令行批准」。
- 外部命令只用固定绝对路径与参数，不经 shell，10 s 超时；只看退出码，不解析输出：

| 动作 | macOS（`/bin/launchctl`） | Linux（`/usr/bin/systemctl --user`，找不到即 unavailable） |
|---|---|---|
| 开 | 预建日志 → 原子写 plist → `print gui/<uid>/com.scry.daemon` 退出码 0 表示已加载：后台服务没在跑就先 `bootout` 再 `bootstrap`，在跑就保留，新定义下次登录生效；未加载则 `bootstrap gui/<uid> <plist>` | 预建日志 → 原子写 unit → `daemon-reload` → `enable` → `start` |
| 关 | 删 plist；后台服务没在跑时再 `bootout` | `disable` → 删 unit → `daemon-reload`；不 `stop` |
| 状态 | 文件识别（§2.5）+ `print` 退出码 | `is-enabled`；`show -p ActiveState,MainPID --value`；`loginctl show-user <uid> -p Linger --value` |
| 由服务拉起 | `kickstart gui/<uid>/com.scry.daemon` | `start scry-daemon.service` |

- 开：已有后台服务在跑时，服务拉起的 supervisor 遇到 `daemon.lock` 以 3 退出、自己以 0 退出。状态显示「当前由 App 启动；下次登录起由系统服务启动」。
- 关：只取消下次登录启动，**不停当前后台服务**。
- 只在打包版、daemon 模式、非测试实例下可用。**按平台放行**：Linux 开关在 Linux 实机验收（P5-4）通过前显示 unavailable；macOS 的结果不代替 Linux。
- `launchedBy` 核对：Linux 用 `MainPID` 与自报 supervisor pid 比对，一致才显示「由系统服务拉起」；macOS 不解析 `launchctl` 输出，显示为「自报」。

### 2.4 与 supervisor、两把锁、现有动作的关系

| 情形 | 行为 |
|---|---|
| 已装服务、后台服务没在跑、App 打开 | 经服务管理器拉起（上表末行），仍按 `ensureDaemon` 等 10 s。**拉起失败**（登录项被关、`bootstrap` 出错、超时）就退回 `spawnDaemonSupervisor` 直接拉起，原因显示在 run 路径与设置页 |
| 「重启后台服务」 | 不变：身份复核后 SIGTERM daemon → daemon 0 → supervisor 0 → 服务管理器不重启；然后按上一行拉起 |
| 「退出 Scry 与后台服务」 | 不变；下次登录或下次打开 App 再起 |
| `SCRY_HOST_DAEMON=0` 的 App | 持有 userData 锁，服务拉起的 daemon exit 4，不重试（[P3-userdata-lock](P3-userdata-lock.md) 3b） |
| 另一个 userData 已装服务 | 拒绝覆盖（`login_start_other_userdata`），显示对方路径 |

`daemon.lock` 与 userData 锁的身份核对不变：服务拉起的 daemon 命令行仍是同一个 asar 入口。

### 2.5 升级、移动、删除 App

识别「是我们的」不靠注释行：按渲染格式严格解析出实际值（程序、asar、userData），或与当前渲染逐字节比较。

| 情形 | 结果 |
|---|---|
| 与当前渲染逐字节相同 | 无事 |
| 原地升级 | 路径不变；打开 App → 不一致弹窗 → 重启 → 版本对上 |
| 无界面机器上升级（SSH 里 `pacman -Syu`） | `scry-host` 与旧 daemon 版本不同，硬失败并提示 `scry-host restart`（[P5-host-cli](P5-host-cli.md) §3.8）。旧进程按路径懒加载的文件会读到新版本，属既有风险 |
| App 被移动 | 解析出的旧程序路径**已不存在**、且 userData 相同 → 按当前路径重写并记日志。旧路径还在（另一份 App）或 userData 不同 → 只显示，不动 |
| App 被删除、服务仍在 | macOS 记系统日志，Linux unit 为 failed（203/EXEC），都不重试。文档给清理命令（`launchctl bootout gui/$(id -u)/com.scry.daemon`、`systemctl --user disable scry-daemon.service`，再删文件） |

### 2.6 不得放宽的边界

- 启动环境清洗：服务文件清掉 §2.1 那组变量，supervisor 仍按 allowlist 给 daemon 环境；只写 §2.2 列出的策略变量。
- 私有 CLI 仍用绝对路径；不加监听端口，桌面访问仍只在 `127.0.0.1`。

### 2.7 平台差异

- macOS：LaunchAgent 只在图形登录后加载（`Aqua`）；重启后要有人登录一次。
- 只做 `systemd --user`；没有 systemd 时 unavailable（P3 §12 第 4 条）。
- **不自动开启 lingering。** 状态显示 `Linger=no` 及其后果，给出 `loginctl enable-linger` 由用户执行。开了以后开机即启动，但没有登录会话：无 `SSH_AUTH_SOCK`、密钥环锁着（§6）。
- Arch/Hyprland：不改 `hyprland.conf`，不调用 `import-environment`，不依赖 `graphical-session.target`。
- 后台服务不需要密钥环；App 连接后台服务仍需要（F2 规则不变）。

### 2.8 失败时用户看到什么

| 失败 | 设置页 |
|---|---|
| 写文件失败 / 命令非 0 / 超时 | 开关复原，显示机器码与退出码；不留半写的文件 |
| macOS `bootstrap` 非 0 | 「系统拒绝加载（可能在 系统设置 → 通用 → 登录项 中被关闭）」+ 退出码；不猜具体原因 |
| 含密钥的环境变量 | `login_start_secret_env`，§2.2 |
| 服务指向别的 App 或 userData | 显示路径，不覆盖 |
| supervisor 确定性失败 / 都拉不起 | 沿用 `supervisor-failure.json` / `daemon_unavailable:<reason>` |

## 10. 决定

### 10.1 已决定（维护者 2026-11-18，评审后「都按推荐」）

1. **命令行认证**：每个请求一次性挑战文件，不存长期 secret（[P5-host-cli](P5-host-cli.md) §3.3）。
2. **入口**：独立的 `<resources>/bin/scry-host`，不放进 recorder CLI。
3. **`invite`/`approve` 只允许交互**；另需「允许命令行批准」开关，默认关，只能在 App 里打开。
4. **批准方式写进 grant**，分两次发布：先发兼容读取，再开始写；界面写「记录为…」，旧 grant 显示「未记录」。不另设审计文件作为事实来源。
5. **装了服务后 App 经服务管理器拉起**；拉起失败退回直接拉起，并在 run 路径上说明原因。
6. **macOS 用 LaunchAgent plist**，不用 `SMAppService` 或登录项（[P5-host-security](P5-host-security.md) §8）。
7. **自动重写服务文件**只在「解析出是我们的、同一 userData、旧程序路径已不存在」时。
8. **64 条上限**：第 2 步前单独清理，见 [P5-host-security](P5-host-security.md) §4.5。
9. **停止、策略、环境**：停止等待、`SHELL`、日志预建在 P5-0，策略变量在 P5-1（[P5-host-security](P5-host-security.md) §7）。
10. **开关关闭时放行只收紧的命令**：`cancel`、`revoke`、`desktop-off` 仍可用，每次都通知（[P5-host-security](P5-host-security.md) §4.3）；无界面机器丢了手机可经 SSH 撤销。
11. **`SCRY_RUN_CONTROLS`、`SCRY_PROVIDER_MANIFEST_URL`** 与其余非机密策略变量一起写进服务文件（§2.2）。

没有待决定事项。

## 评审后修订（2026-11-18）

- 第 1 步：supervisor 停止时等 daemon，补停止超时，只在异常死亡时重启；策略变量随服务写入，含 token 的拒绝；补 `SHELL`、日志预建、版本与 `launchedBy`；清理名单扩充；模块不依赖 Electron、开启前确认、按平台放行；服务文件按实际值识别（§2）。
- 第 2 步：挑战认证、默认关闭的批准开关、运行标记、通知、速率、`restart`、`login-start`；批准方式进 grant，去掉审计文件；清理覆盖已撤销/过期的 grant（[P5-host-cli](P5-host-cli.md)、[P5-host-security](P5-host-security.md)）。
- 核对代码后与评审意见的出入：`SCRY_REMOTE_RELAY_SSH` 没有读取方，删掉而不是据此拒绝；`SCRY_RUN_CONTROLS`、`SCRY_PROVIDER_MANIFEST_URL` 也影响行为，一并写入；Codex 与终端没有 `SCRY_MANAGED_RUN_ID`，另加 `SCRY_HOST_CHILD`；`remote-attention.ts` 不是推送通道，通知走 app-event-feed 与新的宿主能力。
