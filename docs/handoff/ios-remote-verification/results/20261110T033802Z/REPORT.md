# 本机验证报告（第二轮，时间戳 20261110T033802Z）

## 环境

- 验证所用的 revision：`3714bf6f572ee177ae136b423c9bbf4cd0d71d54`（第二轮 TASK 的基线）+ 本报告「修复提交」的 3 个本机修复。开始时工作区只有本结果目录未跟踪（`dirty=1` 来自 `results/`），产品代码无未提交改动。
- Mac：macOS 27.3 / arm64（Apple Silicon）/ Xcode 26.6 (17F113) / Swift 6.3.3 / Node v24.18.0。
- iPhone：iPhone 13（iPhone14,5，UDID `<device-udid>`），iOS 26.5.2，USB、已解锁、已信任；App 就地更新为 `com.scry.remote.local`（免费描述文件 3 App 上限内）。
- 网络：**Mac 仍未接入 Wi-Fi**（`en0` = `<public-ip>/19`，公网企业网），手机自报 `localNetwork: true`，所以两者不在同一局域网；所有隧道实际走 relay，出口 Cloudflare `PIT/ORD/EWR`（美国节点，流量出境）。本轮所有耗时都包含这条出境路径。
- Relay：本轮**没有部署**。`relay-probe mac`（`relay-probe-mac.jsonl`）显示 `relayGeneration=heartbeat-aware`、关闭码 `4001 host_offline`、`relayWaitMs=600`，即第一轮授权的部署仍然有效。
- 用户授权：允许重启 Scry（是，用户于本机 23:13 手动退出并重开）、R5 同 Wi-Fi 前提判 blocked（用户选择不切网）、蜂窝场景（未授权，未测）。
- 本机负载：本轮大部分时间机器被无关工作占满（`load average` 116–135，主要来自 AliEntSafe CloudShell、WindowServer 与其他会话）；下文 `install-mac` 与一次单测抖动都与该负载有关。

## 判定

- Verdict：**fail**（`SUMMARY.md` / `acceptance.json`）。唯一失败的必需规则是 `R7-offline-fast`（2 个样本都判出 `hostOffline=true`，但最慢 3478 ms > 3000 ms）；`R5-direct` 为 blocked（环境前提不成立）。
- 通过的必需规则：`R1-checks`（`ios-checks` 已按 TASK 记为已知基线）、`R2-netbench-clean`（两个场景 `failures=0`）、`R3-transport`（两个场景都 `multiplexed` 且 5 个能力齐全、`legacyHost=false`）、`R4-relay-only`、`R5b-no-blocking-unproven-route`（两个场景 `phase=open` 的失败直连尝试均为 0）、`R6-catalog`（两个场景刷新都 **3/3 confirmed**）。

## 每条未通过的规则

| 规则 | 现象（含证据文件） | 根因 | 已尝试的修复 | 需要的决定或负责人 |
|---|---|---|---|---|
| R7-offline-fast | `wifi-relay` offline-probe 2765.9 ms、`wifi-auto` 3478.0 ms，两者 `hostOffline=true`（`netbench-wifi-relay.jsonl`、`netbench-wifi-auto.jsonl`）；跨本轮所有运行，probe 落在 2.05–3.48 s，**分类每次都正确** | 探测耗时 = 中继升级 + relay 的 600 ms 宽限，而不是重试。`I3-relay-path` 显示这条出境路径上 `upgrade` 中位 1561.9 ms、`upgradeExcludingWait` 中位 961.9 ms；`prewarm()` 并行开 control/bulk 两条 lane 并等**两条都结束**（历史诊断里两条 lane 的 `totalMs` 分别是 2.45 s 与 3.27 s），所以探测值取的是较慢那条。3000 ms 的预算正好落在这条路径的抖动区间内 | 修好了分类缺陷（见修复提交 `a6b2b687`：内层 TLS 把中继的 4001 关闭报成 `uncleanShutdown`，导致 `hostOffline=false` 并重试）。另外试过让 `prewarm()` 在收到 4001 时 `cancelAll()` 提前返回，并写了 NIO 夹具测试；实测该测试在修复版上仍耗时 1209 ms——`RelayLane.usableConnection()` 等的是被保存的 `opening` Task（结构化并发的取消不会打断它），所以这个改动**不成立**，已整体回滚，没有提交 | 需要维护者定：要么让 lane 打开对取消有响应（改 `RelayLane` 生命周期，风险高于本轮范围），要么把 R7 的 3000 ms 改成相对中继升级耗时的表达（例如 `upgrade P50 + 600 ms + 余量`）。本报告不放宽规则 |
| R5-direct | `SUMMARY.md`：`blocked — the Mac advertised no LAN/overlay address`；两个场景 `routes=relay`、`directRoutes=[]` | 环境前提不成立：Mac 不在手机所在的局域网。第一轮暴露的缺陷（VPN/点对点/`/32` 地址被广播、未确认的直连挡在打开路径上）本轮已按要求消除：host 现在什么都不广播（没有可广播的地址），手机也没有任何直连尝试 | 无（TASK 明确：Mac 不在同一 Wi-Fi 时 R5 判 blocked） | 需要一台与手机同 Wi-Fi 的 Mac 才能判定 R5 |

> 核验者注（后续轮次）：上表 R7 一行的"需要维护者决定"已被取代。第三轮（`results/20261110T084031Z`）在不改门限的前提下修复了两处原因：relay 只在 10 s 内有 host leg 活动时才等宽限（`ce3f5fe`），手机任一 lane 收到 `4001` 即返回（`d3ee35a`，用独立任务等待而非 task group，因此不受上面"取消不生效"的限制）；离线答复降到 1.37 / 1.86 s，R7 通过。本行原始数据保持不变。

## 修复提交

| 提交 | 现象 | 根因 | 验证方式 |
|---|---|---|---|
| `a6b2b687` fix(transport): keep the relay's close code through an inner-TLS truncation | 手机连一个没有 host 的房间时报 `uncleanShutdown`、`hostOffline=false` 并重试；relay 侧日志是 `[relay] device mode=run hostLeg=OFFLINE waitedMs=600`（经 `wrangler tail scry-relay` 确认） | `TunnelCodec.retainingCloseCause` 只把 `ProbeError.disconnected` / `ChannelError.ioOnClosedChannel` 还原成中继关闭码。中继不说内层 TLS，NIOSSL 把同一事件报成"没有 close_notify 的截断"，于是覆盖了 4001，`isHostOffline` 判不出来 | 新增 `TunnelCodecTests.testHostOfflineCloseSurvivesInnerTLSUncleanShutdown`：断言 `closed(4001, host_offline)` + `isHostOffline`，并断言真实 TLS 失败与"无关闭码的截断"仍原样抛出。回滚该改动时测试失败（`Inner TLS truncation hid the relay close: uncleanShutdown`），应用后通过。设备侧：offline-probe 从 `uncleanShutdown, hostOffline=false` 变成中文离线文案、`hostOffline=true`，`tunnels` 诊断里出现 `closed(code: 4001, reason: host_offline)` |
| `bbfbf39e` fix(ios): do not remember a "legacy host" verdict across launches | 本轮首次 netbench 就报 `legacyHost=true`、无能力集，`R3-transport` 失败（手机一直用串行回退：无 mux、无流式、无压缩历史、不复用已知会话） | `HostTransportState` 把能力判决（包括 `legacy`）持久化并在启动时恢复；而 `legacy` 也表示"一次 ping 没答上/没解析"，于是被主机重启、睡眠或升级后仍然永久生效——`LaneConnection.establish` 见到恢复的 `legacy` 会**跳过 ping**，真实能力再也读不到 | 新增 `MuxTransportTests.testRelaunchReprobesALegacyHostButKeepsLearnedCapabilities`：重启后 `legacy` 应恢复为 `.unknown`，已学到的能力仍恢复为 `.supported`。回滚时测试失败（`"legacy" is not equal to "unknown"`）。设备侧：第一个 `tunnels` 从 `legacyHost=true, capabilities=null` 变为 `multiplexed=true, capabilities=historyDeflate,mux,ping,sessionsKnown,watchStream` |
| `8d6c1044` fix(ios): keep the offline probe's throwaway session out of transport evidence | 加入离线探测后 `R3-transport` 报 `multiplexed=false`，但主机实际支持 mux | 离线探测用正常 `RemoteRunClient` 连一个随机房间，注册进 `RemoteSessionRegistry` 后没人移除，于是它自己的诊断（没有 host，串行）混进了"这台手机的传输证据" | 抽出 session key 并新增 `discard(...)`，探测结束后丢弃该 session。设备侧：两个场景现在各只有 1 条 `tunnels` 诊断（就是已配对的 Mac），`R3-transport` 通过 |

## 测量结果（L2：仅代表这台机器、这个网络、当下的情况）

样本：两个场景各 5 轮（`-netBenchRounds=5`），串行执行；`-netBench` 本轮不再挂载 App 主界面，因此首页不会并发抢隧道。

| 场景 | 冷开中位数 / P90 | 热请求中位数 / P90 | 列表全量 → 刷新 | 历史下载 | 走的路由 | 机房 |
|---|---|---|---|---|---|---|
| wifi-relay（强制 relay） | 2369.7 / 3742.8 ms | 1210.2 / 1530.1 ms | 929.1 → 810.3 ms（31 会话，3/3 confirmed） | 2587.9 ms | 全部 relay | PIT, ORD, EWR |
| wifi-auto（自动） | 2459.3 / 2854.9 ms | 1022.7 / 2350.5 ms | 1061.3 → 1289.5 ms（31 会话，3/3 confirmed） | 2679.3 ms | 全部 relay（`directRoutes=[]`） | ORD, PIT, EWR |

`wifi-relay` 分阶段中位数：`tcpMs` 8.4、`outerTLSMs` 831.4、`upgradeMs` 1216.8、`innerTLSMs` 2148.7、`pingMs` null、`totalMs` 2148.7；`wifi-auto` 为 8.1 / 729.8 / 1189.7 / 2148.5 / null / 2148.5。能力集两场景一致：`historyDeflate, mux, ping, sessionsKnown, watchStream`（本轮没有 `lan`，因为 host 没有可广播的地址），`legacyHost=false`、`multiplexed=true`。

relay 路径探针（10 样本，本轮未部署）：中位 `total` 1562.1 ms、`upgrade` 1561.9 ms、`upgradeExcludingWait` 961.9 ms、`tls` 528.3 ms，`close.code=4001 host_offline`，`relayGeneration=heartbeat-aware`。

离线探测（每次运行的 `offline-probe`）：`hostOffline=true`，耗时 2.05–3.48 s。较早的运行文件被同名阶段覆盖，最终保留的两个样本是 2765.9 ms（relay）与 3478.0 ms（auto）；修复前的对照输出在 `logs/pre-fix-offline-probe.tail.txt`。

## 与第一轮的对照

| 指标 | 第一轮 `20261109T155516Z` | 第二轮 `20261110T033802Z` |
|---|---|---|
| wifi-relay 冷开 中位 / P90 | 1337.1 / 1677.5 ms | 2369.7 / 3742.8 ms |
| wifi-auto 冷开 中位 / P90 | 1337.5 / 3419.9 ms | 2459.3 / 2854.9 ms |
| wifi-relay 热请求 中位 / P90 | 623.5 / 795.9 ms | 1210.2 / 1530.1 ms |
| wifi-auto 热请求 中位 / P90 | 663.6 / 1017.2 ms | 1022.7 / 2350.5 ms |
| wifi-relay 列表 全量 → 刷新 | 592.1 → 1666.7 ms | 929.1 → 810.3 ms（3/3 confirmed） |
| wifi-auto 列表 全量 → 刷新 | 612.7 → 819.8 ms | 1061.3 → 1289.5 ms（3/3 confirmed） |
| wifi-auto 里的失败直连尝试 | 每条隧道 2 × 900 ms 超时 | 0（`directRoutes=[]`，`phase=open` 无失败尝试） |
| auto 与 relay 的冷开 P90 差 | +1742 ms（3419.9 vs 1677.5） | **−888 ms**（2854.9 vs 3742.8，即 auto 不再比 relay 慢） |

结论：

1. **auto 与 relay 的差距消失了**。第一轮 `wifi-auto` 的 P90 比强制 relay 高 1.7 s，**推断**主要来自两条隧道的 2 × 900 ms 直连超时（两轮的负载、代码和网络耗时都不同，这一点无法单独证明，也不排除其他因素）；本轮 host 不广播不可达地址、手机也不在打开路径上试未确认路由，两个场景的冷开分布已经重合（样本内 auto 甚至更快）。
2. **绝对耗时整体变慢，推断主要是网络路径的变化，而不是本轮改动**（未做控制变量的对照，不能排除代码改动的影响）。两轮都是走同一条出境 relay 路径，但本轮的 `upgradeMs`（1189.7/1216.8）比第一轮（738.2）高约 0.45 s，`outerTLSMs` 也高约 0.4 s；relay 探针的 `total` 两轮接近（1564.1 → 1562.1），**推断** relay 本体变化不大、差异更可能来自这段网络路径的往返与抖动（探针中位数接近不足以证明这两点）。首轮 `diag-order` 的 3720 ms 冷开也在本轮 `wifi-relay` P90 附近，可作旁证。
3. **R6 的判定方式确实修好了规则缺陷**：第一轮 `wifi-relay` 刷新 1666.7 ms 明显慢于全量 592.1 ms 却无法区分（只测 1 次、首页并发）；本轮改为 3 次并记录 host 是否确认"未变化"，两个场景 3/3 confirmed，耗时只作参考。

## 人工观察

- 用户手动重启 Scry 后，`lsof -nP -iTCP:47820 -sTCP:LISTEN` 显示由新进程（启动时间 23:13，晚于 20:05 的安装）持有；`/Applications/Scry.app/Contents/MacOS/Scry` 与 `app.asar` 的 sha1 与 `dist/mac-arm64/Scry.app` 完全一致。
- 手机一度从 USB 上消失（`system_profiler SPUSBDataType` 无设备，`devicectl` 报 `unavailable`），重新插线后为 `available (paired)`；随后又因锁屏导致 `devicectl` 启动失败（`launch failed (device locked?)`），解锁后恢复。这两次都是设备侧状态，不是代码问题。
- 用 `npx wrangler tail scry-relay` 抓到了 relay 的真实行为：`[relay] host leg authed mode=run/pair`、`[relay] device mode=run hostLeg=OFFLINE waitedMs=600`，证明 4001 是 relay 发出的，问题在手机侧的分类。

## 未验证项与原因

- `install-mac` 阶段**没有记成阶段**。按 TASK，本轮用与第一轮相同的手工 pack 步骤安装：`npm run build`、`npm run build:cli`、`node scripts/run-electron-builder.mjs`、`node scripts/check-packaged-app.mjs`（pass，301 762 159 B ≤ 346 030 080 B，CLI 0.2.62，runtime deps 312）、`npm run smoke:electron`（exit 0）、`node scripts/install-macos.mjs`（装到 `/Applications/Scry.app`，备份 `/Applications/.Scry.app.backup`）。`install-mac` 的完整 `npm test` 我先启动了，但当时机器 `load average` 已到 116–135，套件按 ~6 s/文件推进（第一轮约 1.7 s/文件），约 20 分钟只跑到 188/619 文件，我中止了它，因此没有该阶段的记录。基线对照：在 `5760dd71` 的独立 worktree 里跑第一轮失败的那 6 个文件，同样 5 个文件 / 19 条用例超时（`logs/control-base-npm-test.tail.txt`）。
- `node-unit` 第一次跑时 1 条失败（`src/main/remote/relay-connect-ws.test.ts` 的 "stops pinging a leg carrying a phone…"，报 `relay_ws_error`），当时 `load average` 116。该文件随后单独跑 3 次、整组 `src/main/remote src/main/bootstrap` 跑 2 次、`checks` 阶段又跑 2 次，均 599/599 通过；没有改测试也没有改超时。属未复现的抖动，记录在此。
- R5 直连路径、蜂窝场景（M3）、Mac 合盖/唤醒（M4）、大会话历史（M6）：未授权或前提不成立，未执行。
- Linux：本任务只在本机 macOS 验证，未在 Linux 上运行任何阶段。
- `ios-checks` 的 4 条自测失败：与本轮改动无关，已在基线 `5760dd71` 复现（`logs/control-base-ios-checks.tail.txt`），并按 TASK 用 `local-verify.sh mark-baseline ios-checks logs/control-base-ios-checks.tail.txt` 记为已知基线，R1 因此通过。修这 4 条夹具属于另开任务。

## 最终判定

- `summarize.mjs` Verdict：**fail**。`R7-offline-fast` 失败（`hostOffline=true` 但最慢 3478 ms > 3000 ms），`R5-direct` blocked（Mac 不在手机所在局域网），其余必需规则全部 pass。规则表全文见同目录 `SUMMARY.md`。
- 一句话：第二轮的三个规则缺陷与 host 广播缺陷都已按预期消除——`R3`（mux + 全部能力）、`R5b`（0 次失败直连）、`R6`（3/3 confirmed）都通过，auto 与 relay 的冷开差距消失；唯一没通过的是 `R7` 的 3000 ms 时间预算，它是这条出境 relay 路径的升级耗时加 relay 的 600 ms 宽限，而不是判断错误。
