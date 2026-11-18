# P5 · 无界面执行端的安全、测试与拆分（只设计）

状态：设计稿，不含实现。本文接 [P5-headless-host](P5-headless-host.md)（现状、第 1 步、决定）与 [P5-host-cli](P5-host-cli.md)（第 2 步命令行与协议），章节编号连续：§4 安全分析与缓解、§6 测试、§7 拆分与顺序、§8 不做、§9 术语。缓解措施为维护者 2026-11-18 评审后采纳。

## 4. 安全分析与缓解

### 4.1 分析

| 方面 | 今天 | 之后 | 结论 |
|---|---|---|---|
| 同一 uid 的进程 | 已能读明文 CA 私钥（`host-identity.ts:24-28`），改无完整性校验的 `pairing-state.json`，或重启 daemon 抢走 local grant（`local-enrollment-request.ts`） | 多一条有文档、低成本的路径 | **信任边界不变，门槛降低**。补偿见 §4.2–§4.5 |
| Provider / Agent（含 `full_access`、自动授权的仓库 MCP/Hook） | 本就能以本机用户执行任意命令 | 伪终端能满足 TTY 要求，能调用 `scry-host` | 开关打开后，打开不可信仓库可能让配对新设备变成几条命令的事。开关默认关；运行标记拦住照做的 Agent |
| 已配对设备 | 经 Provider 或远程终端在宿主执行命令；远程设备可以持有终端的写入权（`remote-terminal-ownership.ts:1-12`） | 开关打开时，可经 Provider 或远程终端调用 `scry-host approve` | **这实际上就是方案 b**（从已配对设备批准），只是绕一道。明确写出：开关打开即接受这一点。缓解：开关默认关、只能在 App 里打开；运行标记；每次批准通知 App 与所有设备；速率限制 |
| SSH 登录者 | 同一 uid | 正是本步要服务的人 | 符合维护者的判断 |
| SSH streamlocal 转发 | 能把 unix socket 送到别处（`pairing.ts:216-218`） | 转发端连得上 `host-admin.sock`，但读不到挑战文件 | 证明是「能读文件」，不是「能连 socket」（[P5-host-cli](P5-host-cli.md) §3.3） |
| 网络暴露 | 无新端口 | `host-admin.sock` 只是 unix socket | 不变 |
| 指纹钉住、期限、取消、撤销 | authority 检查 | 同一 authority、同一 handler | 不变 |
| 后台服务环境 | App 过滤后的环境 | 服务管理器环境 → 服务文件清理 + 策略快照 + supervisor allowlist | 须实现保证（[P5-headless-host](P5-headless-host.md) §2.1、§2.2） |
| 常驻服务 | 只在 App 拉起后存在 | 随登录常驻、可被远程访问 | 开启前原生确认（§2.3） |
| trust gate、`full_access` 语义 | daemon 内每次重验 | 不变 | 不变 |
| renderer | 不涉及 | 两个布尔参数 | 不变 |
| macOS 隐私授权（TCC） | 由 App 拉起 | 由 launchd 拉起，授权归属可能不同 | **未验证**，L3 必查 |

同一 macOS/Linux 用户下的并发攻击者不在信任模型内（AGENTS §3），本设计不对它作更强承诺。

### 4.2 运行标记

目的：被注入提示的 Agent 照着说明去执行 `scry-host invite/approve` 时被拒。

- 已有：受管 recorder 的 run 带 `SCRY_MANAGED_RUN_ID`（`claude.ts:135`、`opencode-run.ts:118`、`qoder-launch.ts:157`、`pi-run-success.ts:132`）。它**只在受管 recorder 时设**（`claude.ts:134`），Codex 一处也没有（`codex.ts:782`），终端也没有（`terminal-manager.ts:213`）。
- 新增 `SCRY_HOST_CHILD=run|terminal`：在 Provider 运行环境的公共出口 `buildRuntimeCliEnv`（`claude-locate.ts:492-501`，Claude/Codex/OpenCode/Qoder 都经过它）、Pi 的 `pi-run.ts:43`、以及受管与远程终端（`terminal-manager.ts:208-214`）统一加上。
- 后果：在 Scry 自己的终端里也不能批准，要用普通终端或 SSH。
- 局限，照实写：`env -u`、`env -i`、`systemd-run --user`、`launchctl submit`/`asuser` 都能得到干净环境。它挡住照做的 Agent，挡不住恶意代码。

### 4.3 「允许命令行批准」开关与通知

| 项 | 规则 |
|---|---|
| 默认 | 关 |
| 打开 | 只在 App 设置里；main 先原生确认（说明 §4.1 第三行的后果），再经本机 op `localHostAdmin` 写入。没有任何命令行命令能打开它 |
| 关闭 | App 设置里，不确认 |
| 持久化 | daemon 写 `<userData>/remote/host-admin.json`（0600，原子写）；同一用户能改这个文件，与 §4.1 第一行同一结论 |
| 关闭时的 admin socket | 开着，只读加只收紧的方法，后者每次通知（[P5-host-cli](P5-host-cli.md) §3.4） |
| 纯无界面 Linux | 须在 App 界面里打开一次（本机显示或转发） |

通知：命令行 `approve`、`revoke`、`desktop-off`，以及开关被打开时：

- App：daemon 经 app-event-feed（`src/main/remote/app-event-feed.ts:12-25`）发一种新通知；App 弹系统通知（App 现在没有系统通知，新增），点开到设备列表，可直接撤销。
- 已配对设备：新的可协商宿主能力，设备在下次读状态或长轮询时显示「执行端用命令行批准了 X」及撤销方法；旧设备看不到。`remote-attention.ts` 是客户端按目录推出未读角标（1-20 行），不是推送通道，不复用。
- daemon 日志各记一行。

### 4.4 速率限制

- 命令行批准每小时最多 3 次，邀请每小时最多 6 次；超出 exit 6 `host_cli_rate_limited`，给出可重试时间。
- 计数存 `host-admin.json`，`scry-host restart` 不清零。App 界面的操作不计。

### 4.5 配对记录上限的清理

- 现状：配对记录与 grant 各 64 条，从不清理（`pairing.ts:50`，`pairing-state.ts:100`）。`enrollLocal` 也受同一上限（`pairing.ts:191`），表满后 App 自己都无法重新入网。
- 第 2 步前单独做一处小改动（P5-5a），在 `begin`、`enrollLocal` 判上限前与启动时清理：
  - 已取消、已过期、已拒绝的配对记录；
  - 已撤销或已过期的 grant **连同**它的 `paired` 记录（读取端要求每个 grant 都有对应 `paired` 记录，`pairing-state.ts:141`）。
  - 两类都按时间保留最近 16 条，作为可见历史。
- 有效 grant 及其 `paired` 记录不动；未完成的配对不动。
- 清理后的状态是原状态的子集，旧版本照常能读。`status` 显示已用条数。

## 6. 测试与验证

| 层 | 内容 | 环境 |
|---|---|---|
| 单元 | 服务文件渲染：空格、中文、`%`、`$`、引号、控制字符拒绝；不含版本；清理变量在；策略变量写入、非法值与含 token 的拒绝；命令序列与只看退出码（假执行器）；识别与重写条件；main 与命令行渲染逐字节相同；各 unavailable 情形 | 临时 HOME，CI |
| supervisor | 版本取自 bundle；冲突 exit 2；`launchedBy` 透传；**SIGTERM 后等子进程退出**：假 daemon 收到 SIGTERM 后延迟退出，supervisor 必须晚于它退出；超过上限记 `daemon_stop_timeout` | CI |
| 清理 | 满表后 `begin` 与 `enrollLocal` 恢复可用；有效 grant 不动；清理结果能被旧读取端读 | CI |
| grant 字段 | 发布 1 读取端：缺失、两种值、非法值、local grant 带字段；读后写回不丢字段 | CI |
| host-process | admin socket：挑战错/缺/重放/符号链接/非 0600/他人属主；socket 权限；版本不一致；开关关时只读与只收紧可用、其余拒绝；白名单外全拒；速率；中文消息映射为机器码；邀请→证明→错指纹被拒→对的通过→`approvedVia: host_cli` 与通知；撤销本机 grant 被拒 | 临时 userData，扩展 `host-process-pairing.test.ts` |
| 命令行 | node-pty 下交互通过；管道下 `invite`/`approve` 拒绝；带运行标记拒绝；指纹 <16 位、歧义拒绝；后台服务未运行 exit 2 且不生成 `daemon.lock`；`restart` 只发一次 SIGTERM | 临时 userData |
| IPC | `setLoginStart`、`setCliApproval` 的 sender 与参数校验；preload 映射 | CI |
| 打包 smoke | 渲染服务文件到临时目录，用极简环境（`env -i HOME=… PATH=/usr/bin:/bin`，不给 `SHELL`）按其中的程序与参数启动 → 后台服务就绪、握手构建一致、`scry-host status` 可用、SIGTERM 后 daemon 先于 supervisor 退出；`check-packaged-app` 收录 `bin/scry-host` | L2 |

**实机 macOS（需要维护者的 Mac）**：真 `launchctl`；重启后登录即可连；登录项里关闭与重新允许；关闭后（plist 删除、job 未 bootout）再开启；`~/Documents` 下项目的 TCC；ad-hoc 签名的开发构建每次构建 TCC 身份都变；macOS 15「本地网络」权限归属；FileVault 重启后未登录时不运行；`KeepAlive={Crashed}` 的实际重启条件；`ThrottleInterval` 10 s 与 `ensureDaemon` 10 s 等待相撞；`ProcessType` 不设与 `Interactive` 的首 token 与 CPU；注销/关机时 daemon 收尾完整（终端录制、run 结算）；`detached` 的 Provider（`pi-rpc.ts:74`、`qoder-launch.ts:182`）是否成孤儿；Claude CLI 的钥匙串；升级后的不一致弹窗；移动、删除 App；命令行批准手机与桌面及通知。

**实机 Linux（需要维护者的 Linux 机器）**：Arch/Hyprland 上 `systemctl --user`；`Restart=on-abnormal` 的实际条件；`TimeoutStopSec` 内收尾完整；linger 开/关与注销；linger 开机未登录时没有 `SSH_AUTH_SOCK`、密钥环锁着，Provider 的表现；`/usr/bin/scry` 实际指向；pacman 升级后命令行报不一致与 `restart`；日志。

验证级别按 AGENTS「快速迭代」：L0 只跑相关测试与类型检查；L1 每个候选提交跑一次适用门禁；L2 用确切提交的候选包做 smoke；配对批准属门卫类改动，按批做 L3，含中文系统语言与中文工作区路径，记录 OS、locale、版本、是否正式包。缺环境标未验证，一端不代替另一端。

## 7. 拆分与顺序

| # | 内容 | 规模 | 依赖 |
|---|---|---|---|
| P5-0 | supervisor 停止时等 daemon（含测试）；两个入口调 `ensureShellEnv`；模板：不写版本、拆配置读取、转义、清理变量、停止与重启参数、`launchedBy`、日志预建；删 `SCRY_REMOTE_RELAY_SSH` | S | — |
| P5-1 | 无 Electron 依赖的登录时启动模块；策略变量写入与拒绝；daemon 自报有效远程配置 | M | P5-0 |
| P5-2 | 设置开关、原生确认、IPC、文案；经服务管理器拉起与回退；采用时比对配置 | M | P5-1 |
| P5-3 | 打包 smoke | S | P5-2 |
| P5-4 | 第 1 步实机验收，按平台 | — | P5-3 |
| P5-5a | 配对记录清理；grant 读取端兼容 `approvedVia`（发布 1） | S | — |
| P5-5b | 「允许命令行批准」开关（daemon 持久化、App 原生确认）；运行标记 | M | — |
| P5-5 | admin socket、挑战认证、白名单、速率、通知、机器码 | M | P5-5b |
| P5-6 | `scry-host` 入口、`restart`、`login-start`、wrapper、打包 allowlist | M | P5-5、P5-5a、P5-1 |
| P5-7 | 写入 `approvedVia`、设备列表显示、App 与设备的通知展示（发布 2） | S | 与 P5-6 同一发布 |
| P5-8 | 第 2 步实机验收（手机、桌面各一次） | — | P5-6、P5-7 |

- **第 1 步在 c35d0191（打包版默认 daemon 模式）的 macOS 真机验证通过前不合入**：服务会让后台服务在没人打开 App 时自己起来，默认打开路径上的缺陷会变成每次登录都出现。按平台放行：Linux 的开关另等 Linux 真机验证，之前显示 unavailable。
- P5-5a 至少早 P5-7 一个发布，回退一个版本仍读得了状态（[P5-host-cli](P5-host-cli.md) §3.7）。
- 清理（P5-5a）与开关（P5-5b）先于 P5-6 落地；P5-7 与 P5-6 同发，命令行批准从第一天起就有记录。

## 8. 不做 / 以后

- 不依赖 App 的独立安装包（P4 之后）。
- 方案 b 的直接形式（已配对设备上的批准按钮）；已配对设备撤销其它设备。
- 远程策略挪进持久化设置，服务文件只留固定环境。
- 批准口令（命令行批准时另输口令）。
- 系统级 LaunchDaemon、root、登录前运行；自动开启 linger；改 Hyprland 或任何全局配置。
- 非交互批准；终端里画二维码。
- macOS `SMAppService`：plist 静态打包，带不了 userData 路径，而 daemon 必须由调用方给 userData（`src/daemon/main.ts:13-14`）。登录项带参数开 App、`ensureDaemon` 后退出也可行，但没有停止语义、与 Linux 不对称、难在临时目录测；所以用 LaunchAgent plist。
- `daemon.log` 轮转。
- 现有 `local.sock`、`enroll.sock` 也改为 listen 前收 umask（与本设计无关，单独提）。

## 9. 建议的术语（未改 GLOSSARY）

GLOSSARY 目前没有远程相关条目。建议在实现时补：**执行端**（被远程使用的那台机器；代码里叫 host/宿主）、**后台服务**（用户可见的 daemon 名称）、**登录时启动**、**设备**（经配对获得 grant 的另一台机器，不含本机 App）、**配对邀请**（`scry1:` / `scry-desktop1:`，2 分钟有效）、**待确认配对**、**宿主命令行**（`scry-host`）、**允许命令行批准**（默认关的开关）、**批准方式**（记录为 App / 命令行 / 未记录）。
