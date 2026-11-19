结论：需修改

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
