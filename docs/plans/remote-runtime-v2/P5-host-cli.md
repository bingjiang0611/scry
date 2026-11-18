# P5 · 宿主命令行 `scry-host` 与协议（只设计）

状态：设计稿，不含实现。本文是 [P5-headless-host](P5-headless-host.md) 的第 2 步（§3、§5），章节编号与之连续；安全分析与缓解见 [P5-host-security](P5-host-security.md) §4。维护者 2026-11-18 选方案 a：在执行端上用命令行批准新设备；评审后（同日）加上默认关闭的「允许命令行批准」开关等缓解。

## 3. 第二步：宿主命令行 `scry-host`

### 3.1 入口

新的 App 私有入口 `<resources>/bin/scry-host`，形式同 `build/scry-cli`：按 bundle 布局找 Electron，不查 `PATH`；先清掉 [P5-headless-host](P5-headless-host.md) §2.1 那组变量，再以 `ELECTRON_RUN_AS_NODE=1` 运行 asar 内 `out/main/host-cli.js`。userData 按 App 的默认规则推出（代码里没有 `setPath('userData')`），测试实例不支持。

不放进 `scry`：`src/cli/scry.ts` 是 recorder CLI，要求独立于 Electron、可单独经 npm 分发（[Recorder 合同](../../agent/change-checklists.md#recorder--cli-改动)）。Linux 上 `/usr/bin/scry` 很可能是 electron-builder 默认 install 脚本建的、指向 App 本体的链接（`electron-builder.yml:71` `executableName: scry`）；仓库检查只验证 install 脚本存在且语法正确（`scripts/check-pacman-package.mjs:96-103`），没有断言这个链接，以 Linux 实机为准。设置页提供带绝对路径的「复制命令」。

### 3.2 命令

| 命令 | 作用 | 复用 | 交互 | 开关关闭时 |
|---|---|---|---|---|
| `status [--json]` | 后台服务版本/pid/拉起方、进行中的 run 数、登录时启动、远程访问、有效远程配置、批准开关、配对记录用量 | `remote:status`、`remote:desktop:status`、自报 | 否 | 可用 |
| `pending [--json]` | 待确认配对：设备名、完整指纹、剩余时间 | `remote:status` | 否 | 可用 |
| `devices [--json]` | 已配对设备与「记录为」的批准方式，不含本机 App | `remote:status` | 否 | 可用 |
| `invite phone` | 生成 `scry1:` 文本码 | `remote:pairing:begin` | TTY | 拒绝 |
| `invite desktop` | 需要时开桌面访问，生成 `scry-desktop1:` | `remote:desktop:invite` | TTY | 拒绝 |
| `invite … --wait` | 前台等设备提交证明，随即进入 `approve` | 同上 | TTY | 拒绝 |
| `approve [<配对>]` | §3.5 | `remote:pairing:confirm` | TTY + 输入指纹 | 拒绝 |
| `cancel <配对>` | 取消待确认配对 | `remote:pairing:cancel` | 确认；`--yes` 须完整 id | 拒绝（[决定 10.2](P5-headless-host.md#102-需要维护者决定)） |
| `revoke <设备>` | 撤销设备 | `remote:device:revoke` | 同上 | 拒绝（同上） |
| `desktop-off` | 关闭桌面访问，不撤销设备 | `remote:desktop:disable` | 确认 | 拒绝（同上） |
| `restart` | §3.8 | `background-service-stop.ts` | 有 run 时确认 | 可用（不走 admin socket） |
| `login-start enable\|disable\|status` | §3.10 | 登录时启动模块 | `enable` 要 TTY 确认 | 可用（不走 admin socket） |

退出码：0 成功；1 用法或拒绝；2 后台服务未运行；3 版本不一致；4 命令行批准未开启；5 用户取消；6 速率限制。`<配对>`、`<设备>` 交互时可用唯一前缀（≥8 字符），不唯一即拒绝。

已有未完成的邀请时，`invite` 先说明「新邀请会取消它」（`pairing.ts:57-58`）并要确认。

### 3.3 认证：每个请求一次挑战

App 的入网方式不能给命令行用：local grant 只能有一个，新入网会撤销 App 的（`pairing.ts:202-204`）；App 有 grant 时没有入网 secret（`local-enrollment.ts:71-75`）；每次发 grant 会碰到 64 条上限（`pairing.ts:50`、`191`）。

daemon 在 `<stateDir>/host-admin/`（0700）里开 `host-admin.sock`。**listen 前把 umask 收到 0177**，listen 后恢复并复核 0600；不沿用 `local-channel.ts:51-53` 的先 listen 再 chmod。

每个连接一个请求：

1. 命令行发 `{version:1, client:{version, build}}`。构建身份不同（`sameBuild`）即回 `daemon_version_mismatch` 与运行中的版本。
2. daemon 在 `host-admin/` 里以 `O_CREAT|O_EXCL|O_NOFOLLOW`、0600 新建 `challenge-<32 位十六进制>`，写入 32 字节随机数，回文件名。
3. 命令行校验文件名格式，以 `O_NOFOLLOW` 打开后 `fstat`：普通文件、属主是自己、0600；不满足即拒。不用 `statSync`（`local-enrollment.ts:59` 会跟随符号链接）。读出后连同 `method`、`args` 发回。
4. daemon 删除挑战文件（成功、失败、10 s 超时、断开都删），`timingSafeEqual` 比对，再查开关、白名单、速率、参数 schema。

证明的是「调用者能读一个只有本用户能读的文件」，不是「连上了 socket」：SSH streamlocal 转发能把 unix socket 送到别处（`pairing.ts:216-218` 已把它列为威胁），但转发端读不到挑战文件。磁盘上没有长期 secret，也没有轮换竞态。不签发证书，不写 grant；Node 没有对端凭据 API（`local-channel.ts:11-15`），不声称做了更多。

回复只带机器码，同 `enroll.sock`（`local-enrollment.ts:131-134`）。`pairingChannelHandlers` 抛的中文消息（`bootstrap/pairing-channels.ts:21`、`35`、`39`、`45`）在 socket 层映射为 `remote_host_disabled`、`invalid_arguments`、`local_grant_not_revocable`。

### 3.4 白名单

只有 §3.2 中走 admin socket 的方法，调用 `pairingChannelHandlers` 与后台服务自报，和 App 同一份 authority 检查。开关关闭时只放行 `status`、`pending`、`devices`。其余一律 `unsupported_method`：run、会话、文件、终端、项目授权、MCP/Hook trust、本机入网、开关本身、后台服务停止。

开关关闭时仍开 socket、只读：无界面机器上能看到后台服务、配对与设备状态，并得到「命令行批准未开启」（exit 4）这个明确原因，而不是与「后台服务未运行」混在一起的连接失败。只读方法给不出新信息：同一用户本就能读 `pairing-state.json`。

### 3.5 批准流程

1. 只列 `awaiting_local_confirmation` 的配对；`created` 显示「等待设备」。
2. 显示设备名、pairingId 前 8 位、完整 64 位指纹（每 4 位分组）、与 App 相同的前 16 位、剩余时间。
3. 要求输入设备上显示的指纹：至少 16 位十六进制，忽略空格与大小写；必须是该行指纹的前缀；多行匹配即拒（`fingerprint_ambiguous`）。
4. 说明后果（设备成为 owner 设备、`scope: remote`、可按现有权限模式运行 Provider）后，要求输入 `yes`。
5. 提交 `confirm(pairingId, 该行完整指纹)`；authority 再查指纹与 2 分钟期限（`pairing.ts:108-109`、`257-263`）。
6. 成功后通知 App 与已配对设备（[P5-host-security](P5-host-security.md) §4.3）。

### 3.6 非交互与运行标记

- `invite`、`approve` 要求 stdin 与 stdout 都是 TTY，否则 `host_cli_requires_tty`。没有 `--yes`、「全部批准」、`--fingerprint`。
- 调用者环境里有 `SCRY_MANAGED_RUN_ID` 或 `SCRY_HOST_CHILD` 时，`invite`、`approve`、`login-start enable` 拒绝（`host_cli_inside_agent`）。来源与局限见 [P5-host-security](P5-host-security.md) §4.2。
- 邀请里的 secret 只打到 TTY，不写日志、不进 `--json`。
- TTY 与运行标记只防误操作和被注入的 Agent，不是安全边界。

### 3.7 批准方式记在 grant 里

- `DeviceGrant` 新增可选键 `approvedVia: 'app' | 'host_cli'`，只用于 `scope: remote`。值由调用路径定（本机 op 记 `app`，admin socket 记 `host_cli`），不是参数。
- 分两次发布。读取端严格校验键（`pairing-state.ts:88-90`、`106-108`），多一个键旧版本就判 `invalid_pairing_state`：
  - 发布 1（P5-5a）：读取端接受缺失或这两个值，并在返回对象里原样保留（`113-114` 逐字段重建，漏掉就会在下次写回时丢失）；不写。
  - 发布 2（P5-7，与 P5-6 同发）：确认时写入。
  - 先例是 `scope`（`103-105`）：新读取端把缺失当默认，旧读取端读不了新状态；这里多一次发布补上旧读取端。发布 2 降级到发布 1 之前的版本仍会读不了，发布说明写明。
- 界面写「批准方式（记录为）：App / 命令行」，旧 grant 显示「未记录」。配对状态文件没有完整性保护，不显示为已核实。
- 不另设审计文件作为事实来源；daemon 日志每次一行：method、结果码、pairingId/deviceId、指纹前 16 位，不写 secret 与邀请文本。

### 3.8 后台服务没在跑、版本不一致、重启

- 后台服务未运行：exit 2，不拉起。已装服务时打印 `launchctl kickstart gui/<uid>/com.scry.daemon` 或 `systemctl --user start scry-daemon.service`；没装时提示 `scry-host login-start enable` 或打开 App。在 SSH 会话里直接拉起，进程会归属那个会话，环境也不同。
- 版本不一致：exit 3，打印两边版本，提示 `scry-host restart`。
- `restart`：服务正在跑时 `kickstart`/`start` 什么都不做，所以单独提供。复用 `background-service-stop.ts` 的身份复核与一次 SIGTERM，不发第二个信号；run 数取自 `status`；有 run 时先说明会中断几个并要确认，数不出来也问（同 `background-service-actions.ts:60-63`）。daemon 退出后，已装服务就经服务管理器拉起；没装就停在这里并说明。不走 admin socket，开关关闭也可用。

### 3.9 与 App 界面批准对照

| 检查 | App | `scry-host` |
|---|---|---|
| 调用者证明 | local grant（mTLS over unix socket） | 一次性挑战文件 |
| 前提 | 无 | 「允许命令行批准」已开；不在运行标记下；速率内 |
| 版本 | 构建身份完全一致 | 同 |
| 指纹 | 显示 16 位，提交完整指纹 | 显示完整 64 位，须输入 ≥16 位，提交完整指纹 |
| 期限 / 单个待确认 | 2 分钟；新邀请取消旧的 | 同 |
| 设备得到的权限 | `owner-device`、`scope: remote` | 同 |
| 记录 | `approvedVia: app` | `approvedVia: host_cli`；另通知 App 与设备 |

### 3.10 `login-start`

- 用 [P5-headless-host](P5-headless-host.md) §2.3 的同一模块，同样的平台放行规则与失败机器码。
- `enable` 要求 TTY，说明「装一个随登录常驻、可被已配对设备远程访问的服务」后要输入 `yes`；不打开「允许命令行批准」。
- 纯无界面 Linux 由此第一次拉起后台服务（经 `systemctl --user start`，不归属 SSH 会话）。命令行批准仍须在 App 界面里打开一次（本机显示或转发均可）。
- macOS 上 `bootstrap gui/<uid>` 要求该用户有图形会话；只有 SSH 时按退出码报告，plist 已写入则下次图形登录生效。

## 5. 协议与版本

- `REMOTE_PROTOCOL_VERSION` 不变（`src/shared/desktop-remote.ts:180`）。通知设备用新的可协商宿主能力；旧设备看不到，不降级为别的形式。
- 新增只在本机的端点 `host-admin.sock`，帧自带 `version: 1`。
- 本机 op 新增 `localHostAdmin`（读写批准开关），只在本机 socket、`scope: local` 上；admin socket 与远程都够不到。
- 不向远程开放任何新方法，`scripts/daemon-ipc-remote-approvals.json` 保持空。
- IPC：新增 `remote:backgroundService:setLoginStart`、`remote:hostAdmin:setCliApproval`（都在 main，都带原生确认）；`BackgroundServiceStatus` 加 `loginStart`、`cliApproval`；`BackgroundServiceSelfReport` 加 `launchedBy` 与有效远程配置；app-event-feed 加一种通知。App 与后台服务同一构建，不需要兼容层。
- 持久化：`pairing-state.json` 的 grant 加可选 `approvedVia`（§3.7 两次发布）；新增 `<userData>/remote/host-admin.json`（0600，开关与速率计数）。
