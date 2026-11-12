# P3 · B4-S 方案：切换到 daemon 与删除进程内路径（维护者 2026-11-12 已审）

## 目标

1. 把 `SCRY_HOST_DAEMON` 改为默认打开：Agent 运行、终端、会话账本、SQLite、远程设备，全部由 daemon 承载；App 只做窗口、对话框、剪贴板，以及连接其他宿主的客户端。
2. 稳定之后，删除进程内路径和开关本身，并加静态检查，防止它们回来。

原计划写在 [EXECUTION-BATCH4](EXECUTION-BATCH4.md)「B4-S」「B4-V」。本文把它拆成可以单独验收、单独回退的几步，并列出需要维护者决定的点。

## 现状（2026-11-12）

| 项 | 状态 |
|---|---|
| 168 个特权 IPC 通道 | 全部有了去处：留在 main、本机 op、转发或拆分（[STATUS-BATCH4](STATUS-BATCH4.md)） |
| S1 首 token 门禁 | 已批准并满足：P95 146–158 ms，P50 128–134 ms（[P3-s1-absolute-cap](P3-s1-absolute-cap.md)） |
| userData 单写者 | 开关打开、关闭两侧都有锁（[P3-userdata-lock](P3-userdata-lock.md)） |
| macOS 本机验证 | 按组做过：会话、项目、工作台、终端、MCP、计费、配对、桌面接入，全部用 smoke Provider |
| 开关打开时 main 仍会组装的东西 | `index.ts` 里的 Provider 运行时、运行管线（以 daemon 执行模式构建）、终端运行时、`SourceControlService`；8 个文件、12 处按开关分支；`app-lifecycle.ts` 在开关关闭时打开 SQLite |
| 原计划在 B4-S 交付、尚未做的界面 | daemon 状态页；版本不匹配时的「重启后台服务」（现在只报 `daemon_version_mismatch`）；「退出 Scry 与后台服务」；本机连接被撤销后的「重新连接」（[REVIEW-BATCH4-L3C](REVIEW-BATCH4-L3C.md) 的决定，§13.2 链路） |

## 分阶段

每一阶段单独验收，前一阶段没过，不进入下一阶段。

### S0 · 默认打开之前（开关仍默认关闭）

| 编号 | 内容 | 验收 |
|---|---|---|
| S0-1 | 设置页新增「后台服务」：版本、进程、运行时长、userData 位置、已连接设备数；「重启后台服务」（版本不匹配时主动提示）；「退出 Scry 与后台服务」（有运行中的 run 时二次确认）；本机连接被撤销后的「重新连接」，走 §13.2 链路：按 `daemon.lock` 重验身份 → SIGTERM → 二次确认 → 生成新 secret → 重新入网 | 单测与真实 daemon 测试；macOS 上用真实界面重放 |
| S0-2 | **真实 Provider 验收**（需要维护者授权：账号和费用）：Claude 主路径在 daemon 模式下发送、流式、工具调用、审批、停止、恢复会话；原生分支（带 `providerTurnId`）；recorder 提交与记录浏览；MCP OAuth 重新认证。Codex 至少跑一次发送与停止 | 每项都与关闭模式对照；按 CLAUDE.md 用临时 workspace、HOME 与配置 |
| S0-3 | **B4-V 场景表**，开关打开时全部跑一遍：关闭 App 后 run 继续；重新打开接入同一个 daemon；SIGKILL daemon 后 run 记为 `failed(host_restarted)` 且不二次派发；升级时版本不匹配的流程；退出时不留残留进程、lock 和 lease；同一 profile 互斥；trust gate；renderer 隔离 | 脚本化，在 macOS 上由验证 agent 执行 |
| S0-4 | **真实数据副本演练**：把维护者真实 userData 的**副本**放到临时目录，用 daemon 模式启动，检查启动恢复、会话列表、历史、统一对话、终端录制、用量是否和进程内一致 | 只读原件，副本只留在本机临时目录，不上传；需要维护者同意 |
| S0-5 | **打包产物**：`pack:artifact` 之后，在 daemon 模式下跑 smoke，覆盖 worker 路径（run 输出、终端录制）、私有 CLI、资源路径 | `check-packaged-app` 与 daemon smoke |
| S0-6 | **性能**：`performance:measure -- --compare <B4 起点>`；App 启动（daemon 冷启动与已在运行两种情况）；会话打开（`session-open-timing.mjs`）；S1 首 token 复测一轮 | 每个 `worse` 都要说明，回归先修；毫秒级数据在计时锁下测量 |
| S0-7 | **Linux**：在 Ubuntu runner 上做构建产物验收，加 daemon 模式 smoke | Arch/Hyprland 目标机不可用时标为 not-run |

S0 里可以并行的：S0-1（界面）、S0-3（场景脚本）、S0-6（性能脚本准备）、S0-7（Linux）。S0-2 和 S0-4 等维护者授权。

### S1 · 默认打开（保留逃生开关）

- `daemonModeEnabled()` 改为默认 true，`SCRY_HOST_DAEMON=0` 显式关闭（逃生开关），保留一个版本。
- 关闭开关时，userData 锁 A + B 仍然防止两个写者。
- 在 macOS 宿主上按 CLAUDE.md 执行 `npm run install:mac:dev`，维护者的日常 App 开始使用 daemon 模式。

回退：设 `SCRY_HOST_DAEMON=0` 即可，数据格式两种模式一致，不需要迁移。

### S2 · 观察期

- 维护者日常使用 daemon 模式，`userData/performance` 的日常记录作为 L3 证据：首 token、会话打开、发送和停止，同一场景至少 30 个样本、至少 2 个会话。
- 期间发现的问题按普通缺陷处理；涉及数据丢失或证据错误的，立即回退到逃生开关。
- 观察期满、没有未解决的数据或证据问题，再进入 S3。

### S3 · 删除进程内路径（不可轻易回退）

删除：

- 开关本身：`SCRY_HOST_DAEMON`、`daemonModeEnabled()` 和 12 处分支；
- main 里的运行管线、Provider 运行时与 spawn、终端运行时、`SourceControlService`、SQLite 打开与启动恢复、进程内远程宿主（`bootstrap/remote-host.ts` 的宿主部分）；
- 闸门里「开关关闭时直接放行」的路径；共用处理工厂保留，因为 daemon 在用；
- userData 锁中开关关闭那一侧的 App 路径（A + B）：App 不再写 userData，不需要再持锁。daemon 一侧保留。

新增静态检查，并带自检（故意加一个违规导入时它必须失败）：

- `src/main` 的值导入图里，不得出现 Provider 适配器或 spawn、`node-pty`、台账 store、SQLite 写连接；
- `src/main` 里不得出现 `recentStore` / `projectStore` 的写入调用（[REVIEW-BATCH4-FD](REVIEW-BATCH4-FD.md)）。

删除按领域分几次提交，每次都跑全量测试和 B4-V 的相关场景。

### S4 · B4-V 全量验收与交付

按 EXECUTION-BATCH4「交付前全局验证」跑完整一遍：`npm test`、typecheck、build、`build:cli`、performance inventory 与 measure、`test:desktop-remote`、security smoke、`pack:artifact`、`test:renderer:ui`、`git diff --check`；在 macOS 上 `install:mac:dev`，并实测升级场景。无法执行的项写 not-run，并说明原因。

## 风险

| 风险 | 应对 |
|---|---|
| 维护者日常 App 的默认路径改变 | S1 保留逃生开关；S0-4 先用真实数据副本演练；S2 观察期 |
| 已配对的手机在切换后连不上 | daemon 使用同一个 `userData/remote`，CA 与授权相同，理论上无感。S0-3 要验证：进程内配对的设备，切换后仍能连接 |
| 真实 Provider 行为与 smoke 不同 | S0-2 必须在默认打开之前完成 |
| 启动变慢（多一个进程） | S0-6 测 App 启动；daemon 已在运行时 App 不重复拉起 |
| Linux 从未在真实 Electron 下跑过 daemon 模式 | S0-7；目标机未验证就如实标出 |
| S3 删除之后难以回退 | 只在 S2 观察期满之后做；按领域分次提交 |

## 需要维护者决定

1. **分两步**（S1 默认打开并保留逃生开关 → S2 观察 → S3 删除），还是一次到位？**建议分两步。** 观察期建议至少一周日常使用，并且日常记录满足 L3 样本要求。
2. **S0-2 真实 Provider 验收的授权**：Claude（主路径）和 Codex，会产生费用。必须在默认打开之前完成。
3. **S0-4 真实数据副本演练**：只在你的 Mac 上、临时目录里操作副本，不上传，结束后删除。是否同意？
4. **逃生开关保留多久**：建议一个版本，或者到 S3 删除为止。
5. **Linux 的默认值**：一种是与 macOS 同步打开，前提是 Ubuntu runner 验收通过，Arch 目标机标 not-run；另一种是 Linux 先保持关闭，等目标机验证。**建议同步打开**，因为两个平台走同一份代码；如果 Ubuntu runner 验收不过，再单独让 Linux 保持关闭，并在状态里写明。
6. **S0-1 的界面范围**：上表四项（状态、重启、退出、重新连接）是否足够；要不要加「查看 daemon 日志」。

## 维护者决定（2026-11-12）

1. **一步到位。** 不保留逃生开关，没有观察期。S0 全部通过之后，默认打开（S1）和删除（S3）一起做；S2 取消。没有逃生开关，所以回退只能是回到切换前的构建。S0 是唯一的安全网，**每一项都必须通过**，才能进入切换。
2. **真实 Provider 验收授权 Pi 的 `pi:rotom` 与 Codex，费用无上限。** Claude 主路径不在这次授权里，上次的验证机也没有安装 Claude CLI。所以 daemon 模式下的 Claude 真实验收记为 **not-run**，不当作通过；之后有条件时补测。
3. **同意**用真实 userData 的副本演练（S0-4）：只在本机临时目录里操作副本，不上传，结束后删除。
4. 逃生开关：不再适用（见第 1 条）。
5. Linux 与 macOS 同步打开，前提是 Ubuntu runner 验收通过；不过的话，Linux 单独保持关闭，并在状态里写明。
6. S0-1 设置页的范围：状态、重启、退出、重新连接四项，不加日志查看。

## S0 期间的决定（2026-11-12，按执行方建议）

1. **F1（Hyprland 下 safeStorage 选成 `basic_text`）选方案 A**：Linux 上用户没有显式指定 `--password-store`、且桌面为 Hyprland 或未设置时，App 在 ready 之前追加 `password-store=gnome-libsecret`。方案 B（本机 grant 明文保存）不采用；没有密钥环时仍然 fail closed（F2），界面需说明原因。见 [status/b4-s0-linux](status/b4-s0-linux.md)。
2. 「退出 Scry 与后台服务」**不加菜单项**，只在设置页。
3. App 启动时检测到版本不一致，**弹一次原生对话框**，提供「重启后台服务」（走 S0-1 的同一个重启动作）与「稍后」。
4. 通道名 `remote:backgroundService:*` 保持不变。
5. `daemon-packaged-recorder-smoke.mjs` 改为运行 asar 内的 daemon 入口（已完成，见 [status/b4-s0-packaged](status/b4-s0-packaged.md)）。
