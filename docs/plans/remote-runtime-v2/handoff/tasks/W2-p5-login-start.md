# W2 · P5 第 1 步：登录时启动（P5-1 至 P5-4）

## 目标

执行端装了 App，但重启或登录后不用打开 App，后台服务也会起来。设计已定稿，**按设计实现，不重新设计**：

- [P5-headless-host](../../P5-headless-host.md) §1–§2、§10.1（已决定 1–11）
- [P5-host-security](../../P5-host-security.md) §6（测试与真机清单）、§7（拆分，P5-0 已完成）
- P5-0 已提供：`src/daemon/supervisor-templates.ts`（渲染）、`daemon-log.ts`（日志预建）、`supervisor-entry.ts`（版本来自自身、`launchedBy`、`SHELL`）、supervisor 停止等待。

## 范围

| 段 | 内容 |
|---|---|
| P5-1 | 不依赖 Electron 的登录时启动模块（main 与以后的 `scry-host` 共用）：渲染、写入、启用、停用、状态；策略变量（`SCRY_REMOTE_HOST`、`SCRY_REMOTE_PERMISSION_MODE`、`SCRY_REMOTE_RELAY_ENABLED`、`SCRY_DISABLED_PROVIDERS`、`SCRY_RUN_CONTROLS`、`SCRY_PROVIDER_MANIFEST_URL`）在 App 环境里有就校验后写进服务文件，含密钥的 `SCRY_REMOTE_RELAY_WS` 存在则拒绝开启并说明原因；daemon 自报生效的远程配置与 `launchedBy` |
| P5-2 | 设置页开关、main 原生确认（开启时确认，关闭不确认）、typed IPC `remote:backgroundService:setLoginStart` 只传布尔值；装了服务后 App 经服务管理器拉起，失败（登录项被系统禁用、bootstrap 失败）退回直接拉起，并在发送路径上说明原因；采用已在运行的后台服务时比对配置，不一致就提示；服务文件只在「解析出是我们的、同一 userData、旧程序路径已不存在」时自动改写；按平台放行（Linux 未经真机验证前显示 unavailable）；文案遵循 DESIGN.md |
| P5-3 | 打包 smoke：渲染、写入临时位置、解析回读、权限（日志目录 0700、文件 0600） |
| P5-4 | macOS 真机验收（见下） |

## 必须遵守

- 渲染出的服务文件不含版本号；`$` 只在 `ExecStart=` 转义为 `$$`，`%` 处处转义；macOS 用 LaunchAgent plist，`KeepAlive={Crashed:true}`、`ExitTimeOut`；Linux 用 `Restart=on-abnormal`、`KillMode=mixed`、`TimeoutStopSec=30`。以 P5-0 的模板为准。
- 不自动开启 Linux linger，不改任何全局配置。
- renderer 只传布尔值；路径与程序位置全部由 main 决定。
- **测试用的服务标签与路径覆盖**：为了在真机上验收而不碰日常配置，可以加只在测试实例（`SCRY_TEST_APP=1`）下生效的覆盖（标签、服务文件目录、userData），并在设计文档里补一行说明。日常构建里不得生效。

## 验收与自验

| # | 标准 | 做法 |
|---|---|---|
| 1 | 单元：模板、写入、状态、策略变量写入与拒绝、自动改写条件、按平台放行、回退拉起 | 先写失败测试；临时目录 |
| 2 | `npm run typecheck`、受影响目录 vitest、`npm run build` | L0/L1 |
| 3 | 打包 smoke 通过 | 新增脚本入库 |
| 4 | macOS 真机：用测试标签与测试 userData 开启登录时启动 → `launchctl print gui/$UID/<测试标签>` 退出码为 0 → 注销再登录（或 `launchctl kickstart`）后后台服务自动起来，App 未打开也能被已配对的测试客户端连上 → 关闭开关，服务文件删除，后台服务不被停掉 | 全程不碰 `com.scry.daemon` 这个日常标签；用 AX 操作原生确认框 |
| 5 | 停止：`launchctl bootout` 测试标签时 daemon 在 30 s 内收尾，无锁残留；supervisor 被 `kill -ABRT`（只对自己启动、核实过 PID 的进程；macOS `KeepAlive={Crashed:true}` 不重启 `SIGKILL`，见 P5-headless-host §2.1）后被重新拉起 | 记录时间线 |
| 6 | 环境：服务拉起的 daemon 里 `SHELL` 有值、策略变量与 App 一致；含 `SCRY_REMOTE_RELAY_WS` 时开启被拒绝 | daemon 自报 |
| 7 | 真机上只能确认、其他环境无法确认的项：TCC（`~/Documents` 下工作区）、钥匙串（Codex/Qoder 登录态）、Local Network 权限、FileVault 重启后未登录时不可用 | 能测的测，不能测的标未验证并说明 |

## 停止条件

- 任何需要改写日常 `com.scry.daemon` 服务或日常 userData 的步骤：停下，写进「需要维护者决定」。
- 设计与代码冲突：选保守方案，写进报告。

## 报告

`reports/W2.md`。合入 `main` 的门槛是 W1 通过（见 QUEUE）。
