# 本机验证报告（2026-11-09T15:55:16Z 起，本机 macOS 会话跨约 10 小时）

## 环境

- 验证所用的 revision：`2d19ebbac6b5b4f32880ab2c08c9dc4c3ad93635` 加上本报告「修复提交」里列出的本机修复（这些修复先用于让阶段能跑通，随后才提交）。工作区在开始时只有本结果目录未跟踪（`dirty=1` 来自 `results/`），产品代码无未提交改动。
- Mac：macOS 27.3 / arm64（Apple Silicon）/ Xcode 26.6 (17F113) / Swift 6.3.3 / Node v24.18.0。
- iPhone：iPhone 13（iPhone14,5，UDID `<device-udid>`），iOS 26.5.2，USB 连接、已解锁、已信任；App 以 `com.scry.remote.local` 就地更新安装（见下）。
- 网络：**Mac 没有接入 Wi-Fi**（`networksetup -getairportnetwork en0` 返回 "not associated"，`en0` 为 `<public-ip>/19`，非 RFC1918）。手机自报 `localNetwork: true`，所以"同一 Wi-Fi"前提不成立；所有隧道实际走 relay，出口为 Cloudflare **PIT/ORD**（美国节点，流量出境）。Mac 侧无代理绕过：`cf-relay` smoke 按要求取消代理变量后运行。
- Relay：部署前探针 `relayGeneration=pre-heartbeat`（`close.code 1013 no_host_leg`）；经用户授权执行了 `cd experiments/remote-g0/cf-relay && npx --prefix .. wrangler deploy`（Version ID `<id:c61ac638>`），之后探针为 `heartbeat-aware`，拒绝时 `close.code 4001 host_offline`、`relayWaitMs=600`。
- 用户授权：允许重启 Scry（是）、授权部署 relay（是）、蜂窝场景（未授权，未测）。

## 判定

- `summarize.mjs` 首次运行是**静默空转**：脚本用 `file://${argv[1]}` 与 `import.meta.url` 比较，检出路径含空格（`Application Support/...`）时永不相等，于是不写 `summary.json`/`acceptance.json`/`SUMMARY.md` 并 exit 0。已修复（见修复提交），修复后才得到下列判定。
- Verdict：见同目录 `SUMMARY.md` 与 `acceptance.json`（本文件末尾「最终判定」一节记录最终值）。
- 规则表：见同目录 `SUMMARY.md`（`R1..R7`、`I1..I3`）。

## 每条未通过的规则

| 规则 | 现象（含证据文件路径） | 根因 | 已尝试的修复 | 需要的决定或负责人 |
|---|---|---|---|---|
| R1-checks | `checks.json`：`ios-checks` exit 1、`install-mac` exit 1，其余阶段 pass | 两个互相独立的本机/存量问题，见下面两行 | 见下面两行 | 见下面两行 |
| R1-checks / ios-checks | 修复崩溃后 `Catalog checks: 146, failures: 4`：`catalog.followUp.routingDoesNotResumeAnotherProfile`、`catalog.recovery.explicitModelChoice`、`catalog.model.explicitAutoIsRemembered`、`catalog.model.catalogRecoveryRestoresReadiness`（`logs/ios-checks.tail.txt`）。在分支基线 `5760dd71` 的独立 worktree 上用同一份修好的脚本复现同样 4 条（对照输出见 `logs/control-base-ios-checks.tail.txt`） | 不是本分支引入的回归。崩溃本身：`catalog-refresh.py` 从 `ConversationTurns.swift` 里切 `struct TurnOutcomeNote:`，但这个 view 在 `2cdbb1f4` 已移到 `Components.swift`，`str.index` 抛 ValueError。剩下 4 条是自测夹具过时：它们直接赋值 `chosenProvider` 后断言 `controlsReady`，而 `controlsReady` 现在还要求 `providerControlsLoaded && providerControlsCwd == chosen?.path`；插桩打印（临时改动，已还原）显示 `loaded=false cwd=nil chosen=nil`，所以断言必然为假，同组前两条反向断言则变成永远成立的空断言 | 修好了崩溃（切 `Components.swift` 到下一个声明处）；没有为了让它们变绿去改产品自测语义 | 维护者决定是否单独修这些自测夹具（另开任务）。本报告不把修夹具算作本次验证范围 |
| R1-checks / install-mac | `npm run install:mac:dev` 在 `npm test` 阶段 exit 1：619 个测试文件中 6 个失败、17 条用例失败（`logs/install-mac.tail.txt`）；相关测试文件与基线 `5760dd71` 相比**无改动**（`git diff 5760dd7 -- <files>` 为空） | 本机进程启动被企业安全客户端显著拖慢：`/usr/bin/time node -e ""` 实测 1.2–1.7 s（正常约 0.04 s），因此每个 spawn 型用例都撞上 vitest 5 s 默认超时；串行重跑后 `pi-probe-lifecycle`、`commit-environment`、`recorder-attention-process`、`performance-baseline` 全部转绿，剩下的 `check-pacman-package`（4 条）与 `concurrency-trace-launcher`（1 条）仍是 5–8 s 超时 | 没有改全局 `testTimeout`（那等于放宽门禁）。改为按本机既有约定手动完成 pack 的其余步骤：`npm run build`、`npm run build:cli`、`node scripts/run-electron-builder.mjs`、`node scripts/check-packaged-app.mjs`（pass，301 761 763 B < 346 030 080 B，CLI 0.2.62，runtime deps 312）、`npm run smoke:electron`（exit 0）、`node scripts/install-macos.mjs`（装到 `/Applications/Scry.app`，备份 `/Applications/.Scry.app.backup`） | 维护者决定是否给 vitest 配置更宽的超时或在慢速企业机上用 `--maxWorkers=1`（这属于门禁策略，不在本任务授权内） |
| R5-direct | `wifi-auto` 场景 `routes=relay`，`openErrors` 全是 `Connect timeout (900 ms)`；host 只广播了 `172.18.0.1:47820`（`utun13`，点对点）与 `192.168.255.254:47820`（`utun5`，/32） | 环境前提不成立：Mac 未接入 Wi-Fi，唯一的私网地址来自本机 VPN 点对点隧道，手机在自己的局域网上到不了这两个地址。`lanAddresses()` 只广播 RFC1918/100.64 是设计如此（Tailscale 等 overlay 是有意支持），没有代码缺陷证据 | 确认 macOS 防火墙处于关闭状态（`socketfilterfw --getglobalstate` = disabled），确认 `47820` 在 Mac 上监听中（`lsof` 显示 `/Applications/Scry.app` 持有），确认手机自报 `localNetwork=true` | 需要一台与手机处于同一 Wi-Fi 的 Mac 才能判定 R5；或确认手机在该 VPN overlay 内 |
| R6-catalog:wifi-relay / :wifi-auto | `wifi-relay` full=592.1ms → refresh=1666.7ms；`wifi-auto` full=612.7ms → refresh=819.8ms（`netbench-*.jsonl`、`SUMMARY.md`） | 未定论。额外跑了一次 1 轮诊断场景 `diag-order`：full=561.4ms → refresh=618.0ms，在容差内（阈值 723.7ms）。即 5 轮场景下 refresh 多出的时间约等于一次额外往返（relay ≈1 s、直连 ≈0.2 s），而 host 侧 `known` 短路仍要枚举并哈希整个目录（`remote-gateway.ts` 第 318–344 行）——不足以解释 5 轮场景下必然更慢，所以**没有把它当已定位缺陷** | 复核了 host `known`/`unchanged` 路径与手机 `SessionCatalogMemo` 逻辑，未改代码；加跑 1 轮场景作为区分实验 | 需要能读 host 侧耗时的复现（例如在 host 上按请求记录枚举/哈希耗时）才能定因；判定阈值不要动 |
| R7-offline-fast | `SUMMARY.md`：`blocked — scenario host-quit not run`；`checks.json` 无 `netbench-host-quit` 记录 | 场景没跑：host-quit 要求 Scry 处于退出状态时手机跑一轮 `-netBench`，而本 Agent 会话运行在 Scry 进程内（`pi` 是 `/Applications/Scry.app` 的子进程），退出 Scry 会同时杀掉驱动脚本。已提前把这一步做成 LaunchAgent（`results/<stamp>/raw/host-quit-watch.sh`，等 Scry 退出 → 跑 netbench host-quit → 重开 Scry → summarize），并在 `launchctl` 里运行到用户决定跳过为止；relay 已按授权部署并探针确认 `heartbeat-aware`，所以缺的只是这一个场景 | 尝试过两次 in-session 退出（都在退出瞬间被 SIGKILL，只有 App 自身被杀、脚本没跑完），随后改用 launchd 托管任务；用户选择跳过，未执行 | 无需决定：需要人配合退出一次 Scry 才能判定。relay 侧前提已经满足，重跑 `local-verify.sh host-quit` 即可补上 |

## 修复提交

| 提交 | 现象 | 根因 | 验证方式 |
|---|---|---|---|
| `fb79bdb1` fix(test): swallow the held client reset in the LAN listener test | `npm run test:unit -- src/main/remote src/main/bootstrap` 打印 "Test Files 86 passed, Tests 599 passed" 却 exit 1，并报 1 个 unhandled `ECONNRESET`（来自 `remote-lan-listener.test.ts`） | 关闭监听会 destroy 服务端 socket，测试里第二条"被持有"的客户端连接没有 `error` 监听，复位就变成未捕获异常 | `npx vitest run src/main/remote/remote-lan-listener.test.ts`：修复前 1 个未捕获错误 + exit 1，修复后 exit 0；随后整套 `node-unit` 阶段 pass |
| `38962bc1` fix(ios): take TurnOutcomeNote from the file that declares it | `python3 apps/ios/Checks/catalog-refresh.py` 直接抛 `ValueError: substring not found` | 脚本仍从 `ConversationTurns.swift` 切 `struct TurnOutcomeNote:`，该 view 已移到 `Components.swift`（`SessionStatusLine` 留在原文件） | 修复后脚本能编译并输出 `Catalog checks: 146, failures: 4`；基线 worktree 里同样从崩溃变成同样的 4 条失败（对照证据） |
| `09fc60c6` fix(verify): drive the local iPhone run against this host's real app and device | `restart-mac` 卡住/被杀；`install-ios` 报 `ApplicationVerificationFailed`（"maximum number of installed apps using a free developer profile"）；`netbench` 启动报 `Missing value for '-t <seconds>'` | 1) `pgrep -x Scry` 会匹配别的检出留下的 Scry 进程；2) 手机上已有 `com.scry.remote.local`，免费描述文件最多 3 个 App；3) `devicectl` 把 `-netBench...` 当自己的选项解析 | 改为按 `/Applications/Scry.app` 路径匹配、支持 `SCRY_IOS_BUNDLE_ID` 并传给 xcodebuild、app 参数前加 `--`；随后 `build-ios`、`install-ios`、`netbench wifi-relay`、`netbench wifi-auto` 全部 pass |
| `d1277f71` fix(verify): let summarize run from a checkout path with spaces | `node .../summarize.mjs <dir>` 无任何输出、不写 `SUMMARY.md`，exit 0 | 入口判断用 `file://${argv[1]}` 与 `import.meta.url` 比较，路径含空格时永不相等 | 修复后同一命令打印完整规则表；失败运行 exit 1 |
| 本次收尾提交（与结果同一个提交） fix(verify): detect the host process without argv or pipeline status | `stage_env` 报 `scry_running=no`，`restart-mac` 的 `quit_scry` 永远认为 App 未运行；`restart-mac` 子 shell 里报 `pgrep: Cannot compile regular expression` / `Unable to find application named ''` | 三层原因：1) LaunchServices 启动的 Electron 主进程 argv 为空，`pgrep -f` 看不到它（`ps` 能因为它用 `proc_pidpath`）；2) 脚本开头 `set -o pipefail` 会把 `ps | grep -q` 的 SIGPIPE 当失败；3) `declare -f` 传函数进子 shell 时没带 `HOST_APP` | 改为 `ps -Ao command=` 抓一份表再用 `grep -q -x -F` 比对，不再用管道；并把 `HOST_APP` 与 `host_running` 一起传进子 shell。验证：`stage_env` 现在报 `scry_running=yes`；子 shell 干跑（把 quit/open 换成打印）输出 `would-quit` + `would-open /Applications/Scry.app`。**`restart-mac` 阶段本身没有端到端重跑**：它做的就是退出并重开 App，在 App 内执行会自杀 |

## 测量结果（L2：仅代表这台机器、这个网络、当下的情况）

样本：每个场景 5 轮（`-netBenchRounds=5`），串行执行；`diag-order` 是 1 轮诊断。Mac 侧负载：同一台机器同时运行 Scry、Xcode 与本次验证脚本。

| 场景 | 冷开中位数 / P90 | 热请求中位数 / P90 | 列表全量 → 刷新 | 历史下载 | 走的路由 | 机房 |
|---|---|---|---|---|---|---|
| wifi-relay（强制 relay） | 1337.1 / 1677.5 ms | 623.5 / 795.9 ms | 592.1 → 1666.7 ms（31 会话） | 1776.5 ms | 全部 relay | PIT, ORD |
| wifi-auto（自动） | 1337.5 / 3419.9 ms | 663.6 / 1017.2 ms | 612.7 → 819.8 ms（31 会话） | 1769.8 ms | relay（直连均 900 ms 超时） | PIT, ORD |
| diag-order（1 轮诊断） | 3720.3 / 3720.3 ms | 695 / 930 ms | 561.4 → 618.0 ms（31 会话） | 1601.8 ms | relay | PIT, ORD |

`wifi-relay` 的分阶段中位数：`tcpMs` 7.4、`outerTLSMs` 388.8、`upgradeMs` 738.2、`innerTLSMs` 1327.9、`pingMs` null、`totalMs` 1327.9。能力集（两条隧道都一致）：`historyDeflate, lan, mux, ping, sessionsKnown, watchStream`，`legacyHost=false`，`multiplexed=true`。

relay 路径探针（10 样本）：部署前 `generation=pre-heartbeat`，中位 total 853.8 ms，关闭码 `1013 no_host_leg`；部署后 `heartbeat-aware`，中位 total 1564.1 ms（含 `relayWaitMs=600` 宽限），`upgradeExcludingWait` 中位 964 ms，关闭码 `4001 host_offline`。

## 人工观察（可选）

- 未做人机交互观察（未发送真实提示、未手动切换 Wi-Fi/蜂窝、未合盖测试）：本任务未授权蜂窝场景，且本次运行中 Mac 不在 Wi-Fi 上。`-netBench` 本身是只读的，使用手机已有配对。
- 观察到的现象：手机首次 `devicectl` 启动被拒（"profile has not been explicitly trusted" / 锁屏），解锁后正常启动；这属于设备侧状态，不是代码问题。

## 未验证项与原因

- R5 直连路径：Mac 未接入 Wi-Fi（见上），需同网环境重跑 `netbench wifi-auto`。
- R6 在 5 轮场景下的定因：缺 host 侧分阶段耗时证据，只做了 1 轮对照实验。
- 蜂窝场景（M3）、Mac 合盖/唤醒（M4）、大会话历史（M6）、手动流式与切网（M7）：未授权或未执行。
- Linux 平台：本任务只在本机 macOS 上验证，未在 Linux 上运行任何阶段。
- `install-mac` 阶段的 `npm test` 全量套件：本机慢启动导致 6 个文件失败，手工完成 pack 的其余步骤（check-packaged-app / smoke:electron / install-macos 全部通过），但 `npm test` 本身在本机仍不绿。
- `ios-checks` 里 4 条自测失败：基线复现，未修（见上表）。

## 最终判定

- `summarize.mjs` Verdict：**fail**（`acceptance.json`；`R1-checks`、`R5-direct`、`R6-catalog:wifi-relay`、`R6-catalog:wifi-auto` 为 fail，`R7-offline-fast` 为 blocked）。规则表全文见同目录 `SUMMARY.md`。
- 已通过的必需规则：`R2-netbench-clean`（三个场景 failures=0）、`R3-transport`（三个场景都 `multiplexed` 且五个能力齐全、`legacyHost=false`）、`R4-relay-only`（`wifi-relay` 全程 relay）。
- `restart-mac` 没有记成阶段：该阶段本身就是 "退出并重开 App"，在 App 内执行的脚本一定会在退出瞬间被杀（本报告写作时用户选择不再重启 App，也不再跑 host-quit）。因此 `logs/restart-mac.tail.txt` 已从结果里移除——它只是那次被杀的调用留下的部分输出，不代表阶段结论。重启事实由以下证据证明：`/Applications/Scry.app` 进程启动时间晚于本次安装、`lsof` 显示它监听 `47820`、手机 `tunnels` 诊断里 host 声明 `ping/mux/watchStream/sessionsKnown/historyDeflate` 且 `legacyHost=false`——只有新 host 代码才可能声明这些能力。
- 结论一句话：本机验收**未通过**，但不是本次 iOS 远程改动的主路径失败——它是 1 个既有自测遗留 + 1 个本机测试环境问题（`npm test` 慢启动超时）+ 1 个网络前提不成立（Mac 不在 Wi-Fi）+ 1 个未定因的刷新耗时规则 + 1 个需要人配合的场景。
