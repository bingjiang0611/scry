# P5 · 宿主命令行批准、安全分析与协议（只设计）

状态：设计稿，不含实现。本文是 [P5-headless-host](P5-headless-host.md) 的第 2 步部分（§3–§5），章节编号与之连续；现状、第 1 步、测试、拆分与待决定事项见该文。维护者 2026-11-18 选方案 a：在执行端上用命令行批准新设备，不采用从已配对设备批准（方案 b）。

## 3. 第二步：宿主命令行 `scry-host`

### 3.1 入口

新的 App 私有入口 `<resources>/bin/scry-host`，形式同 `build/scry-cli`：按 bundle 布局找 Electron，不查 `PATH`；先 `unset` [P5-headless-host](P5-headless-host.md) §2.1 那组 Node 变量，再以 `ELECTRON_RUN_AS_NODE=1` 运行 asar 内 `out/main/host-cli.js`。

不放进 `scry`：`src/cli/scry.ts` 是 recorder CLI，要求独立于 Electron/SQLite、可单独经 npm 分发并自动更新（[Recorder 合同](../../agent/change-checklists.md#recorder--cli-改动)）；Linux 上 `/usr/bin/scry` 还指向 App 本体（`scripts/check-pacman-package.mjs:96`）。设置页提供带绝对路径的「复制命令」。

### 3.2 命令

| 命令 | 作用 | 复用的 handler | 交互 |
|---|---|---|---|
| `status [--json]` | 后台服务版本/pid/拉起方、登录时启动、远程访问、桌面端口、待确认数、设备数 | `remote:status`、`remote:desktop:status`、后台服务自报 | 否 |
| `invite phone` | 生成 `scry1:` 文本码；会取消之前未完成的邀请 | `remote:pairing:begin` | 需要 TTY |
| `invite desktop` | 需要时开启桌面访问，生成 `scry-desktop1:` 邀请 | `remote:desktop:invite` | 需要 TTY |
| `invite … --wait` | 留在前台等设备提交证明，随即进入 `approve` | 同上 | 需要 TTY |
| `pending [--json]` | 待确认配对：设备名、完整指纹、剩余时间 | `remote:status` | 否 |
| `approve [<配对>]` | 见 §3.5 | `remote:pairing:confirm` | 需要 TTY，必须输入指纹 |
| `cancel <配对>` | 取消待确认配对（authority 只有取消，没有单独的拒绝状态） | `remote:pairing:cancel` | 确认；`--yes` 须给完整 pairingId |
| `devices [--json]` | 已配对设备，不含本机 App 的 local grant | `remote:status` | 否 |
| `revoke <设备>` | 撤销设备 | `remote:device:revoke` | 确认；`--yes` 须给完整 deviceId |
| `desktop-off` | 关闭桌面访问，不撤销设备 | `remote:desktop:disable` | 确认 |

退出码：0 成功；1 用法或拒绝；2 后台服务未运行；3 版本不一致；5 用户取消。`<配对>`、`<设备>` 交互时可用唯一前缀（≥8 字符），不唯一即拒绝。

### 3.3 认证

App 的入网方式不能给命令行用：local grant 只能有一个，新入网会撤销 App 的（`pairing.ts:202-204`）；App 有 grant 时没有入网 secret（`local-enrollment.ts:71-75`）；每次调用发一个 grant 会很快碰到 64 条上限（`pairing.ts:50`、`191`），且撤销的 grant 不清理。

方案：daemon 在状态目录再开一个 `host-admin.sock`（0600，目录 0700），并在每次启动时写 `host-admin-token`（32 字节随机，0600，原子写，退出时删除；可重复使用，不按时间过期）。

- 每个连接一条换行结尾的 JSON 请求、一条回复，形式同 `enroll.sock`（`local-enrollment.ts:105-137`）：`{version:1, token, client:{version, build}, method, args}`。
- 校验顺序：token（`timingSafeEqual`，文件权限不是 0600 即拒）→ 构建身份完全相同（`sameBuild`，否则 `daemon_version_mismatch` 并带上运行中的版本）→ method 在白名单 → 参数 schema。
- 证明与 `enroll.sock` 同级：同一 uid 才能连上 socket、读到 token。不签发证书，不写 grant，不碰 `pairing-state.json` 的格式。Node 没有对端凭据 API（`local-channel.ts:11-15`），不声称做了 uid 校验之外的事。
- 网络端点（relay、SSH 转发的两个端口）够不到它。

既有上限：配对记录与 grant 各最多 64 条，从不清理（`pairing.ts:50`、`191`，`pairing-state.ts:100`）；每次邀请占一条配对记录，取消、过期的也留着。命令行让邀请更便宜，会更早碰到 `pairing_capacity_exceeded`，此后手机和桌面都无法再配对。`status` 显示已用条数；是否清理见 [P5-headless-host](P5-headless-host.md) 决定 8。

### 3.4 白名单

只有 §3.2 表中的 handler，调用的是 `pairingChannelHandlers` 与后台服务自报，和 App 走同一份代码、同一组 authority 检查。其余一律 `unsupported_method`：run、会话、文件、终端、项目授权、MCP/Hook trust、本机入网、后台服务停止/重启。

### 3.5 批准流程

1. 只列 `awaiting_local_confirmation` 的配对；`created`（设备还没提交证明）显示「等待设备」。
2. 显示设备名、pairingId 前 8 位、完整 64 位指纹（每 4 位分组）、与 App 相同的前 16 位、剩余时间。
3. 要求输入设备上显示的指纹：至少 16 位十六进制，忽略空格与大小写；必须是该行指纹的前缀；多行同时匹配即拒绝（`fingerprint_ambiguous`）。
4. 说明后果（设备成为 owner 设备、`scope: remote`、可按现有权限模式运行 Provider）后，要求输入 `yes`。
5. 提交 `confirm(pairingId, 该行的完整指纹)`，与 App 一样钉住指纹；authority 再查一次指纹与 2 分钟期限，设备换了密钥或过期即失败（`pairing.ts:108-109`、`257-263`）。过期就重新邀请。
6. 领取语义不变：批准后设备随时领取证书。

这比 App 界面多一步「输入指纹」。App 界面本步不改。

### 3.6 非交互

- `invite`、`approve` 要求 stdin 与 stdout 都是 TTY，否则 `host_cli_requires_tty`。没有 `--yes`、没有「全部批准」、没有 `--fingerprint`。
- 邀请里的 secret 只打到 TTY，不写日志、不进 `--json`。
- `cancel`、`revoke`、`desktop-off` 只收紧权限，可用 `--yes` + 完整 id 在脚本里执行。
- TTY 只防误操作和无人值守的调用，不是安全边界：同一用户的进程可以用伪终端绕过（§4）。

### 3.7 记录

- daemon 日志每次一行：method、结果码、pairingId/deviceId、指纹前 16 位；不写 secret 与邀请文本。
- 新增 `<userData>/remote/pairing-audit.jsonl`（0600，追加）：`{at, action, via, pairingId?, deviceId?, publicKeySHA256?}`，`via` 为 `app` 或 `host_cli`。App 经本机 op 的动作也写，记 `app`。
- grant 的 `source` 保持 `local_confirmation`：`pairing-state.ts:106-108` 严格校验键与取值，加字段或新值会让旧版本读不了配对状态。
- 设备列表（App 与 `devices`）显示「批准方式：App / 命令行 / 未记录」；本设计之前的 grant 记「未记录」，不当作 App。

### 3.8 后台服务没在跑

命令行**不拉起后台服务**，exit 2，并给出下一步：已装服务时打印 `launchctl kickstart gui/<uid>/com.scry.daemon` 或 `systemctl --user start scry-daemon.service`；没装时让用户打开 App 或开启登录时启动。原因：在 SSH 会话里直接拉起，进程会归属那个会话（Linux 注销即被杀，macOS 不在 Aqua 会话里），环境也与 App/服务不同；只读的 `status` 更不能有启动副作用。版本不一致时 exit 3，打印两边版本和同一条重启命令。

### 3.9 与 App 界面批准对照

| 检查 | App | `scry-host` |
|---|---|---|
| 调用者证明 | local grant（mTLS over unix socket） | token + 0600 socket，同一 uid |
| 版本 | 构建身份完全一致 | 同 |
| 指纹 | 显示 16 位，点击后提交完整指纹 | 显示完整 64 位，须输入 ≥16 位，提交完整指纹 |
| 期限 / 单个待确认 / 领取 | 2 分钟；新邀请取消旧的；以宿主状态为准 | 同 |
| 设备得到的权限 | `owner-device`、`scope: remote` | 同 |
| 记录 | 新增 `via: app` | `via: host_cli` |

## 4. 安全分析

| 方面 | 今天 | 之后 | 结论 |
|---|---|---|---|
| 同一 uid 的进程 | 已能读明文 CA 私钥（`host-identity.ts:24-28`），改无完整性校验的 `pairing-state.json`，或写入网请求文件、重启 daemon 抢走 local grant（`local-enrollment-request.ts`） | 多一条有文档、低成本的路径；不必抢 App 的 local grant，少了一个可见的副作用 | **信任边界不变，门槛降低**。补偿：审计、设备列表显示批准方式 |
| Provider / Agent（含 `full_access`、自动授权的仓库 MCP/Hook） | 本就能以本机用户执行任意命令 | 能调用 `scry-host`；TTY 要求可被伪终端绕过 | 不新增权限，但打开不可信仓库后，配对新设备变成两条命令的事 |
| 已配对设备 | 经 Provider 在宿主执行命令 | 同上，可间接走命令行批准，实际效果接近方案 b | 不是新权限；维护者需知悉 |
| SSH 登录者 | 同一 uid，同第一行 | 正是本步要服务的人 | 符合维护者的判断 |
| 网络暴露 | 无新端口 | `host-admin.sock` 只是 unix socket | 不变 |
| 指纹钉住、期限、取消、撤销 | authority 检查 | 同一 authority、同一 handler | 不变 |
| 后台服务环境 | App 过滤后的环境 | 服务管理器环境 → 服务文件清理 + supervisor allowlist | 须实现保证（[P5-headless-host](P5-headless-host.md) §2.1、§2.5） |
| trust gate、`full_access` 语义 | daemon 内每次重验 | 不变 | 不变 |
| renderer | 不涉及服务 | 只多一个布尔参数 | 不变 |
| macOS 隐私授权（TCC） | 后台服务由 App 拉起 | 由 launchd 拉起，访问 `~/Documents` 等目录的授权归属可能不同 | **未验证**，L3 必查 |

同一 macOS/Linux 用户下的并发攻击者不在信任模型内（AGENTS §3），本设计不对它作更强承诺。

## 5. 协议与版本

- `REMOTE_PROTOCOL_VERSION` 不变（`src/shared/desktop-remote.ts:180`）。
- 本机 op 表不增加；新增一个只在本机的端点 `host-admin.sock`，帧格式自带 `version: 1`，复用现有 handler。
- 不向远程开放任何东西，`scripts/daemon-ipc-remote-approvals.json` 保持空。
- IPC：新增 `remote:backgroundService:setLoginStart`（main）；`BackgroundServiceStatus` 加 `loginStart`；`BackgroundServiceSelfReport` 加 `launchedBy`。App 与后台服务同一构建，不需要兼容层。
- 持久化：新增 `pairing-audit.jsonl`；`pairing-state.json` 格式不变。
