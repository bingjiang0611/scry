# 本机验证报告 — 2026-11-10T15:39:56Z（第四轮：同一 Wi-Fi 决 R5）

## 环境

- 验证所用 revision：`a0a2881b402a368c43fbd30f2221affc5543bce5`（分支 `claude/ios-remote-connection-issues-o7oj6x`，验证开始时 `dirty=1`）。本轮唯一的代码提交是 `8ec746a5`（见「修复提交」），它在本轮 iOS 构建与测量之前落地，`swift-test` 阶段已在提交后重跑。
- Mac：macOS 27.3 / arm64（Mac14,9，Apple M2 Pro）/ Xcode 26.6 (17F113) / Swift 6.3.3 / Node v24.18.0。
- iPhone：iPhone 13（`<device-udid>`），iOS 26.5.2，与 Mac 在同一 Wi-Fi（Mac `en0` = 192.168.0.100/24，网关 192.168.0.1）。
- Relay：`wss://scry-relay-pages.pages.dev`，探针 `generations=heartbeat-aware`、`relayWaitMs=0`、close `4001 host_offline`，colo ORD/PIT。本轮**未部署** relay（沿用第三轮的 `<id:07c468e9>`）。
- 用户授权：允许重启 Scry（本轮重启过一次，用于加载新装的 Mac 构建）；允许在手机上三次手动信任新安装的 iOS 构建；未测蜂窝场景；未部署 relay。

## 判定

`summarize.mjs` 的 Verdict：**fail**（规则表全文见同目录 `SUMMARY.md`）。

| 规则 | 必需 | 结果 | 摘要 |
|---|---|---|---|
| R1-checks | 是 | fail | `install-mac` 未完成（见下）；`ios-checks` 为已知基线 |
| R2-netbench-clean:wifi-auto | 是 | pass | failures=0 |
| R2-netbench-clean:wifi-relay | 是 | **fail** | failures=1（冷开 #1 = 31136 ms） |
| R2-netbench-clean:wifi-relay2 | 是 | pass | failures=0（见「R2」一节的复现实验） |
| R3-transport:* | 是 | pass | multiplexed，全部能力（含 `lan`） |
| R4-relay-only | 是 | pass | routes=relay |
| R5-direct | 是 | **fail** | advertised 192.168.0.100:47820，但直连 Connect timeout (900 ms) ×2 |
| R5b-no-blocking-unproven-route:* | 是 | pass | 打开路径上失败的直连尝试 = 0 |
| R6-catalog:* | 是 | pass | 三场景 confirmed 3/3 |
| R7-offline-fast | 是 | **fail** | samples=3，最慢 3277.6 ms > 3000 ms |

## 每条未通过的规则

| 规则 | 现象（含证据文件路径） | 根因 | 已尝试的修复 | 需要的决定或负责人 |
|---|---|---|---|---|
| R1-checks（`install-mac`） | `npm run install:mac:dev` 在本机负载 load average 294 下大量 vitest 用例 `Test timed out in 5000ms`、子进程被信号杀死（`exitCode: null`）。中断现场见 `logs/install-mac-interrupted.tail.txt`、`logs/install-mac.tail.txt`（阶段状态 `fail`，exit 143 = 被中止）。 | 机器过载，不是代码。同一失败模式在 base `5760dd71` 的对照里也出现（`results/20261110T033802Z/logs/control-base-npm-test.tail.txt`：5 个文件 / 19 处超时）。 | 按 §4 改走手工打包路径：`npm run build && npm run build:cli && node scripts/run-electron-builder.mjs` → `check-packaged-app` exit 0 → `npm run smoke:electron` exit 0 → `node scripts/install-macos.mjs` 装入 `/Applications/Scry.app`；安装后二进制 sha1 与 `dist/mac-arm64` 一致。证据：`logs/evidence-install-mac-manual-pack.txt`。 | 需要在机器不繁忙时补跑一次完整 `install-mac`（含 `npm test`）才能让 R1 的这项从 fail 变成 pass。 |
| R2-netbench-clean:wifi-relay | 冷开 #1 = 31136.1 ms，错误 `I/O on closed channel`；同一轮 2–5 次冷开 2.7–4.1 s。证据：`netbench-wifi-relay.jsonl`、`logs/netbench-wifi-relay.failed-162247Z.tail.txt`。 | **未定位**。已确认触发条件：新实例在**上一个实例被强制结束后的几秒内**启动。控制实验（`wifi-relay2`，先把 App 结束并等 25 s 再启动）：冷开 #1 = 1802.9 ms，failures=0。所以不是启动路径本身慢，而是「同一设备的旧中继腿还没消失就重连」。旧腿属于 relay 房间或 host 侧，本轮没有拿到 relay/host 的腿生命周期证据。 | 第三轮起共观察到 3 次（第三轮 5/5 卡 31 s、本轮 1 次、控制实验 0 次）。未做代码修改：没有证据证明是哪一侧持有旧腿，改任一侧都是猜。 | 需要 relay 房间的腿生命周期证据（`wrangler tail scry-relay` 属于只读，但需要授权以生产 worker 做观测）或 host 侧重连日志，才能定位。在此之前这条只能记为「强制结束后立即重连会卡 30 s」。 |
| R5-direct | 手机确实学到 Mac 的局域网地址：`capabilities` 含 `lan`，`directRoutes=[{192.168.0.100, 47820}]`（`netbench-wifi-auto.jsonl` / `netbench-wifi-relay.jsonl` 的 `tunnels` 事件）；但两条 lane 的直连升级都 `Connect timeout (900 ms)`。证据：`logs/evidence-mac-lan-interfaces.txt`。 | 环境限制：这台 Mac 的 `en0` 是合成网卡（`ether 02:00:00:00:00:00`；网关 192.168.0.1 能 ping 通 2.6 ms，但 `arp -an` 全程为空），手机在物理 Wi-Fi 上无法到达 192.168.0.100。逐项核对任务给的 5 条：①Scry 在听 `*:47820`（`lsof` 见证据文件）；②macOS 防火墙已关闭（`State = 0`）；③iOS 本地网络权限未单独验证（见未验证项）；④`directRoutes` 见上；⑤同一网段假设不成立——Mac 这一侧不是物理局域网。 | 本轮真正的修复是**让手机学到地址**（提交 `8ec746a5`）：修之前手机持久化的状态是 `{"routes":[],"capabilities":[...,"mux",...]}`（`logs/evidence-phone-transport-state.before-fix.txt`），带 `mux` 就跳过 ping，而 ping 是唯一读局域网广播的地方，所以永远学不到。修之后 `capabilities` 含 `lan`、`directRoutes` 非空，两条 lane 都发起了直连升级。 | R5 的「直连可用」需要在真机上重测：把 Scry 跑在**物理 Wi-Fi 网卡**的 Mac 上（`en0` 有真实 MAC、`arp` 能解析网关），手机同一网段。本工作树所在宿主是合成网卡，无法验收这一条。 |
| R7-offline-fast | 三个场景的 offline probe 分别 2354.3 / 3277.6 / 1842.1 ms，全部 `hostOffline=true`；最慢 3277.6 ms 超 3000 ms 门槛。证据：三个 `netbench-*.jsonl` 的 `offline-probe`。 | **未定位**。所有样本都正确判定「Mac 不在线」，只是其中一个样本多花了约 1 s（≈ 一次重试或一次额外 TLS 往返）。relay 侧 `relayWaitMs=0`、`4001 host_offline` 已确认（`relay-probe-mac.jsonl`），第三轮同样条件下曾 1371.6 / 1855.4 ms 通过，说明这里是抖动而不是回归。 | 未改代码。`summarize.mjs` 的门槛按要求未动。 | 需要在网络安静时重测一次；若稳定超门槛，再查 `openRelayOnce` 里 250/800 ms 重试序列是否被 uncleanShutdown 类错误触发。 |

## 核验者更正（见 `TASK.md`「第四轮核验结论与第五轮」）

- R2 的 31 s 卡顿：失败记录的 31 次打开尝试都没有 `tcpMs`，说明手机到 Cloudflare 的 TCP 都没连上，relay 根本没收到连接。上文"同一设备的旧中继腿还没消失就重连"的归因因此不成立，撤回。"强制结束后立即重启会触发"这个触发条件仍然成立。
- R5：上文"en0 是合成网卡"是推断，未证实；iOS 本地网络权限也还没核实，所以失败原因暂时不能定为环境限制。第五轮将用 `waitingReason` 来判断。

## 修复提交

| 提交 | 现象 | 根因 | 验证方式 |
|---|---|---|---|
| `8ec746a5` `fix(transport): re-read the host's advertisement after a remembered open` | 手机在同 Wi-Fi 下从不使用 Mac 的局域网地址：`directRoutes` 恒为空，全部走 relay。 | 能力与路由跨启动持久化；带 `mux` 能力时 `LaneConnection.open` 跳过 ping，而 ping 是唯一读取 host 局域网广播的地方。Mac 加入 Wi-Fi 后手机永远不会知道。 | `swift test` 96 tests / 0 failures，含新增 `testAdvertisementRefreshLearnsRoutesAfterCapabilitiesWereRemembered`；真机对照：修前 `capabilities` 无 `lan`、`directRoutes=[]`，修后含 `lan`、`directRoutes=[192.168.0.100:47820]` 且两 lane 发起直连升级。 |

回滚对照的说明：这次改动是「新增一条后台刷新路径」，把它删掉后新测试直接编译不过，因此没有「回退即失败」的单元对照；行为对照由上面的真机前后状态提供（同一构建、同一网络、同一天）。

## 测量结果（L2：仅代表这台机器、这个网络、当下的情况）

| 场景 | 冷开中位数 / P90 | 热请求中位数 / P90 | 列表全量 → 刷新 | 历史下载 | 走的路由 | 机房 |
|---|---|---|---|---|---|---|
| wifi-auto | 3383.3 / 4760 | 1121.4 / 3377.7 | 1293.8 → 1331.6 | 11024.3 | relay | ORD,PIT |
| wifi-relay | 2771.3 / 4064.3 | 1435.5 / 2967.5 | 1538.8 → 816.6 | 19770.6 | relay | ORD,PIT |
| wifi-relay2（控制实验） | 1802.9 / 2565 | 1024.1 / 1365.2 | 720.7 → 715.7 | 10807 | relay | ORD,PIT |

relay 探针（本机 → `wss://scry-relay-pages.pages.dev`）：中位 dns 2.1 / tcp 7.4 / tls 713 / upgrade 1156.9 / close 1157.1 ms，`4001 host_offline`，heartbeat-aware。

## 与上一轮的对比

- R7 从「1371.6 / 1855.4 ms 通过」变成「2354.3 / 3277.6 / 1842.1 ms，一个样本超门槛」：relay 未变、代码未变，属抖动，但按规则如实记为 fail。
- R5 的阻塞点从「Mac 没有局域网地址可广播」变成「手机学到了地址但连不上」，其中「学不到」这一半已由 `8ec746a5` 修掉。
- 冷开中位数：wifi-relay 3060.4 → 2771.3 ms，wifi-auto 3747.5 → 3383.3 ms。同构建同网络下这属于抖动范围，不作为「变快」的结论。

## 未验证项与原因

- `install-mac` 阶段本身（含 `npm test`）：机器过载中断，按 §4 走手工打包替代；需要在空闲机器上补跑。
- `restart-mac`、`host-quit`：Agent 运行在 Scry 内部，不能重启或退出宿主 App；本轮未运行。relay 的 offline 判定改由 netBench 的 offline probe 覆盖。
- iOS「设置 → 隐私与安全性 → 本地网络」是否已对 ScryRemote 放行：未单独确认。由于 Mac 侧 `en0` 是合成网卡（`arp` 为空），即便放行也无法从这台宿主验收直连。
- 蜂窝场景：未测（任务未要求）。
- 31 s 冷开卡顿：只确认了触发条件，未定位到哪一侧持有旧的中继腿。

## 产物与可复现命令

- 全部原始证据：`docs/handoff/ios-remote-verification/results/20261110T153956Z/`（`checks.json`、`acceptance.json`、`SUMMARY.md`、`*.jsonl`、`logs/`、`logs/evidence-*.txt`）。
- 本次运行使用的阶段序列：
  `env` → `checks`（提交 `8ec746a5` 之后重跑）→ `install-mac`（手工打包替代，见 `logs/evidence-install-mac-manual-pack.txt`）→ `build-ios` → `install-ios` → `relay-probe mac` → `netbench wifi-relay -netBenchRoute=relay -netBenchRounds=5` → `netbench wifi-auto -netBenchRounds=5` → `netbench wifi-relay2 -netBenchRoute=relay -netBenchRounds=5`（控制实验）→ `summarize`。
