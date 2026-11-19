结论：需修改（第二轮：无阻塞，剩 4 项应修，见文末「复核」）

# W2 核验（核验方，2026-11-19）

提交：`c49a13c5`（P5-1）、`431f908e`（P5-2）、`4a3cebc1`（P5-3）、`8a6c0619`（P5-4）。

## 已核对、符合设计

- 模板：无版本；`%` 处处转义、`$` 只在 `ExecStart=`；plist `KeepAlive={Crashed:true}`、`ExitTimeOut=30`、`AssociatedBundleIdentifiers`；unit `Restart=on-abnormal`、`KillMode=mixed`、`TimeoutStopSec=30`；Node/DYLD 变量清空；控制字符拒绝。
- 六个策略变量写入（但见 B1），`SCRY_REMOTE_RELAY_WS` 在写文件前拒绝；daemon 自报 `launchedBy`、`supervisorPid`、`remoteConfig`；Linux 显示不可用；关闭开关不停运行中的后台服务；服务管理器失败与就绪超时都回退直接拉起；采用服务拉起的后台服务时比对配置。
- 安全：preload 只转发一个值，main 校验 `args.length===1 && typeof boolean`，走 `registerTrustedIpcHandler`；开启前 main 原生确认（默认取消）；`execFile` 固定二进制与参数、无 shell、10 s 超时；服务文件以 `O_CREAT|O_EXCL|O_NOFOLLOW, 0600` 写临时文件再 `rename`，目标是符号链接时拒绝；没有 `SCRY_TEST_APP=1` 时找不到能改标签或路径的环境变量。
- 改动最小：`host-process.ts` +1 行，`index.ts` +4/−3，通道门控只加一个通道。
- 文件大小：没有超过 20,000 字节的文件（接近上限：`P5-headless-host.md` 19,993、`host-process.ts` 19,984、`preload/index.test.ts` 19,802、`main/index.ts` 19,766）。

复跑（Linux，root 容器）：`npm run typecheck` 通过；受影响的 22 个测试文件 182 个用例通过；全量 vitest 863 个文件中 5 个失败，**同样 5 个在基线 `d812fd21` 上也失败**（root 下目录权限测试、两个真实 Chromium 渲染测试、owned-process 清理测试），与本任务无关。

## 需修改（执行方 B）

**阻塞**

- **B1 策略快照比 App 自己的环境更宽**（`src/daemon/login-start/policy-env.ts:190-199`）：校验时 `trim` 后写入修剪过的值，而真实读取方不修剪（`remoteHostEnabled` 只认 `'1'`/`'0'`；`host-process.ts:228` 用原值判断权限模式）。核验方用探针复现：App 环境 `SCRY_REMOTE_HOST=" 1"`、`SCRY_REMOTE_PERMISSION_MODE=" full_access"` 时，App 拉起的后台服务远程关闭、无权限覆盖，服务文件里却是开启远程、`full_access`。修法：`raw !== raw.trim()` 即拒绝开启，或用读取方的原样谓词校验并写入原值；`SCRY_DISABLED_PROVIDERS` 也不要改大小写。加负面测试。

**应修**

- **S1** 开启时会覆盖另一个仍存在的 App 的服务文件（`manager.ts:254-264`）：同 userData、程序路径不同且旧路径仍存在时，`status()` 报冲突，但 `enable()` 仍写入。main 必须强制决定 7（旧路径存在就只提示），不能只靠界面隐藏开关。加测试。
- **S2** `bootout` 没有身份核对（`manager.ts:286-292`、`334-336`）：服务文件不存在时仍对固定标签执行 `launchctl bootout`，可能卸掉另一个 userData 已删除文件但仍加载的任务。只在文件存在且解析为「我们的、同一 userData」时 bootout。
- **S3** 定义改变后不会重新加载（`manager.ts:287`、`360-368`）：macOS 用 `kickstart` 只按上次 bootstrap 的定义启动。关闭再开启、或「App 移动后自动改写」之后，仍会跑旧环境或已不存在的旧路径（多等 10 s 才回退）；而不一致提示文案（`constants/background-service-copy.ts:113`）正是让用户这么做。修法：没有后台服务在跑时，由 App 拉起改为 `bootout`（忽略失败）再 `bootstrap`，或记录「定义已变」标志。需在 Mac 上验证。
- **S4** 发送路径上的提示可能丢失：`BackgroundServiceNoticeStrip` 只在聊天视图挂载，hook 只听推送、不主动读取（`hooks/useBackgroundServiceNotice.ts`）；main 只在发生回退或不一致时推送一次（`bootstrap/background-service.ts:132-141`、`242-258`）。挂载时主动读取一次当前提示。
- **S5** 「是我们的」判断太宽（`parse.ts:62-121`）：忽略被清空变量的非空值（如 `NODE_OPTIONS=--require x`）、多余的环境键、`ExecStartPre=` 等多余行；正则还会匹配 XML 注释。改为用解析出的值重新渲染并要求逐字节一致，否则视为「已被修改」的冲突。
- **S6** 真机验收没覆盖默认路径形态（`scripts/login-start-macos-acceptance.mjs`）：userData 用 `/tmp/scry-p54-mac-XXXX`，没有空格和中文；测试 plist 写进真实 `~/Library/LaunchAgents`；没有 SIGINT 清理，中途中断会留下开机即启动、远程开启的测试服务。改为：服务文件目录用 `SCRY_TEST_LOGIN_START_DIR` 指向临时目录、userData 路径含空格与中文、加信号清理。脚本只调模块，没经过 main、IPC 与原生确认，报告里写明。
- **S8** 补负面测试：服务文件路径是符号链接时的开启与关闭；`runFixedCommand` 真实 `execFile` 的超时与找不到命令；回滚时恢复原有文件；B1 的空白；S1 的覆盖；`createDaemonRunMode` 带 `launchFallback` 的第二次 `ensureDaemon`；setLoginStart IPC 的「确认后开启」路径。

**Linux 放开之前必须修（现在开关在 Linux 上不可用，可以排在后面）**

- **S7** `systemctl show -p ActiveState,MainPID --value`（`manager.ts:192-197`）假定输出顺序与 `-p` 顺序一致，实际按总线属性顺序，`launchedByVerified` 可能永远为假；改为不带 `--value`、按 `Key=Value` 解析。`enable` 后 `start` 失败没有回滚（设计 §2.8 要求开关回到关闭）。相对路径的 `XDG_CONFIG_HOME` 应按规范忽略（`paths.ts:126`）。

**可选**

- `status()` 与 `canLaunchViaService()` 会触发自动改写，读状态导致写文件；读错误（EACCES）被报成 `login_start_foreign_service`，应单列原因。
- App 侧期望配置从 `SCRY_REMOTE_RELAY` 推出 `custom_tcp`（`policy-env.ts:259`），但这个变量不转发给后台服务，会产生误报的不一致。
- 「纯 Node」模块导入 `main/remote/remote-defaults`，连带拉入通道门控和所有本机 op 表（约 56 KB）；拆出一个纯函数。
- App 从 DMG 或被系统移位（`/AppTranslocation/`、`/Volumes/`）运行时，开启会生成下次登录就失效的服务；考虑拒绝并提示。
- `P5-headless-host.md:129`「日常构建完全忽略这些变量」不准确：门控是运行时的 `SCRY_TEST_APP=1`，不是构建类型。改为「不带 `SCRY_TEST_APP=1` 启动时忽略」。

## 需要维护者决定

- **验收第 5 项改用 SIGABRT**：macOS 上 `KeepAlive={Crashed:true}` 按定义只在崩溃类信号后重启，SIGKILL 不重启（执行方实测：SIGKILL 不重启、SIGABRT 10.4 s 后重启）。核验方同意保留 `Crashed:true`（改成 `SuccessfulExit=false` 会让配置错误或锁被占时每 10 s 重启一次），也同意不加 `ThrottleInterval`。代价：macOS 上 supervisor 被 SIGKILL 后，要等打开 App 或下次登录才恢复；Linux 的 `on-abnormal` 对 SIGKILL 会重启。两端差异要写进设计 §2.1 与 §6。

## 合并门槛

P5-4 只部分通过（原生确认框未用 AX 实测、未做真实注销再登录、§6 第 7 项 TCC/钥匙串/本地网络/FileVault 未验证），加上上面的决定未定。按 P5-host-security §7，第 1 步在这些关闭、且 W1 通过之前不合入 `main`。

## 复核（第二轮，2026-11-19，修复提交 `eebb2f1f`、`0bf91973`、`eeb6ac1d`）

复跑（Linux）：受影响的 18 个测试文件 151 个用例通过；`tsc` node 与 web 均通过。另把新测试放到修复前的 `53dd5b9f` 上跑：16 个失败，证明它们确实覆盖了修复（符号链接拒绝、回滚恢复、`execFile` 超时与找不到命令、「开启不动运行中的后台服务」4 个在旧代码上也通过，只防回归）。

| 项 | 结论 |
|---|---|
| B1 | 已修，有测试（`policy-env.ts:43` 前后空白即拒绝，写入原值；`SCRY_DISABLED_PROVIDERS` 不改大小写） |
| S1 | 已修，有测试（`manager.ts:146-148`；main 开启前调 `precheckEnable`） |
| S2 | 部分：`disable` 无文件不再 bootout；但见下面应修 1、2 |
| S3 | 逻辑已改为 bootout 再 bootstrap，执行方在 Mac 上实测；文案未改（应修 3） |
| S4、S5、S6、S8 | 已修，有测试；S6 只在执行方的 Mac 上跑过 |
| S7 | 已修，用假的执行器测试；Linux 真机未跑 |
| 可选 | 2–5 已修；1 部分：`status()` 已只读，`canLaunchViaService()` 仍会改写（启动路径上有意为之），报告「纯只读」说法要改 |

**仍需修改（执行方 B）**

1. **回归**：后台服务运行中关闭开关（文件删除、任务仍加载）→ 后台服务随后停止 → 再开启时 `daemonRunning=false`，被 `login_start_loaded_without_file` 拒绝（`manager.ts:291-293`），要注销才能恢复。这正是 P5-host-security §6 列的真机场景，验收脚本只在 `daemonRunning:true` 下重开（`login-start-macos-acceptance.mjs:241`）。修法：`launchctl print` 显示没有 pid 的空闲任务可以 bootout（停掉的不是任何运行中的东西），或用其他方式确认归属；补测试与真机复测。
2. **归属证明被跳过**：`manager.ts:289` 的 `if (daemonRunning) return { ok: true }` 在 `!hadOwnedFile` 检查之前，于是「任务已加载、无文件、我们的后台服务在跑」时会写入我们的 plist，而不证明已加载的任务属于谁；之后 `startViaService`（`:383`）无条件 bootout，可能卸掉别的 userData 的任务。归属证明要放在这个分支之前。
3. **文案**：`renderer/constants/background-service-copy.ts:118`「关闭再重新开启「登录时启动」或重启后台服务」——两者单独都不生效，改为「关闭再重新开启…，然后重启后台服务」。
4. **设计文档过期**：`P5-headless-host.md` §2.3 表（`:122-125`）仍写 `kickstart`，没写重新加载、无文件拒绝、只在有自己的文件时 bootout；任务单 `handoff/tasks/W2-p5-login-start.md` 第 5 行仍写 `kill -KILL`，改为 SIGABRT。

**可选**：`startViaService` 只在任务未运行时 bootout，或处理 bootout 10 s 超时与 `ExitTimeOut=30` 的冲突；`disable` 也拒绝 `login_start_other_app`（同 userData 但属于另一个仍存在的 App）；EACCES 测试改为注入读取错误，使 root 下也能跑；严格解析下，模板一旦改动，旧版本写的服务文件会被判为「外来」，下次改模板前要准备旧模板的识别或迁移。

**合并门槛不变**：AX 点原生确认框、真实注销再登录、签名包上的 TCC/钥匙串/本地网络/FileVault、Linux 真机。
