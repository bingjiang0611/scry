# 本机验证报告（第三轮，时间戳 20261110T084031Z）

## 环境

- 验证所用的 revision：`7a5ff0bf8c8d4187cadda75655b4247f80d0fe8e`（第三轮 TASK 的基线）。本轮**没有**任何本机修复，工作区开始时只有本结果目录未跟踪（`dirty=1`）。
- Mac：macOS 27.3 / arm64 / Xcode 26.6 (17F113) / Swift 6.3.3 / Node v24.18.0。Mac 侧代码 `git diff 7ccd437 -- src` 为空，按 TASK 未跑 `install-mac`、未重装或重启 Scry（运行中的 Scry 仍是第二轮装的构建，PID 87295 一直持有 47820）。
- iPhone：iPhone 13（UDID `<device-udid>`），iOS 26.5.2，USB；本轮重新安装了 App（`build-ios` 后 `install-ios`），首次启动需要在手机上手动信任开发者，之后正常。
- 网络：Mac 仍未接入 Wi-Fi（`en0` = `<public-ip>/19`），手机 `localNetwork: true`；所有隧道走 relay，出口 `PIT / EWR / ORD`。
- Relay：**已按用户授权重新部署**（`wrangler deploy`，Worker `scry-relay`），Current Version ID `<id:b8c1540d>`，生效证据见下（`relayWaitMs` 600 → 0）。
- 本机负载：验证期间机器多次被无关工作占满（`load average` 57–168），其中一次 `sleep` 被 SIGKILL；下面的现象里有一段与设备/USB 反复掉线、负载过高有关，均已注明。

## 判定

- Verdict：**incomplete**（`SUMMARY.md` / `acceptance.json`，**只覆盖每个阶段的最后一次运行**）。按最后一次运行，没有必需规则失败；`R5-direct` 是 blocked（Mac 不在手机所在局域网），因此判定为 incomplete 而不是 pass。
- 通过：`R1-checks`（`ios-checks` 的四项失败记为已知基线：它们在 main 基线上同样复现；**但"基线复现即豁免"是核验者定的规则，尚未经维护者确认**，确认之前 R1 的通过只在这个前提下成立）、`R2-netbench-clean` ×2、`R3-transport` ×2（mux + 5 项能力）、`R4-relay-only`、`R5b` ×2（`phase=open` 失败直连 0 次）、`R6-catalog` ×2（3/3 confirmed）、**`R7-offline-fast` 通过**（样本 1371.6 ms 与 1855.4 ms，都 ≤3000 ms）。
- **单列、不被重跑抵消**：`wifi-relay` 前两次尝试冷开全部失败（`I/O on closed channel`，约 31.1 s，原因未定位，见下文「现象」第 1 条与核验者更正），第三次重跑通过。第一次有原始日志支持（`logs/attempt1-netbench-wifi-relay.tail.txt`，5/5 失败）；**第二次的数量只是事后手写记录**（`logs/attempt2-note.tail.txt`，原始文件已被覆盖），未经核实。`SUMMARY.md` / `acceptance.json` 只反映最后一次运行，因此 `R2-netbench-clean` 显示为通过；这次未定位失败如何计入，留待维护者决定。

## 本轮改动的验证

| 改动 | 预期证据 | 实测 |
|---|---|---|
| `ce3f5fe` relay 在没有近期 host leg 时立即 `4001` | `relay-probe-mac.jsonl` 的 `relayWaitMs` 为 0 | 10 个样本全部 `relayWaitMs=0`（第二轮是 600），关闭码仍 `4001 host_offline`，中位 `total` 941.9 ms、`upgrade` 941.7 ms、`tls` 536.2 ms |
| 同上 | 设备侧离线答复不再含 600 ms 宽限 | `hostLeg=OFFLINE waitedMs=0`（`wrangler tail scry-relay`），offline-probe 从第二轮的 2.77–3.48 s 降到 1.37–1.86 s |
| `d3ee35a` 任一 lane 收到 4001 即返回 | offline-probe 不再取两条 lane 中较慢的那条 | offline-probe 两个场景分别为 1371.6 ms、1855.4 ms；同一时段单条 lane 的 `totalMs` 中位 1711–1937 ms，**推断**探测在第一条 lane 返回 4001 时就结束了（只是耗时接近，未记录同一次探测中两条 lane 各自的完成时间，不是直接证据） |
| 3000 ms 门限未改动 | — | 两轮都未修改 `summarize.mjs` 或阈值；`git diff 7ccd437 -- experiments/remote-g0/verify` 为空 |

## 测量结果（L2：仅代表这台机器、这个网络、当下的情况）

样本：两个场景各 5 轮，串行执行；`-netBench` 不挂载主界面。

| 场景 | 冷开中位数 / P90 | 热请求中位数 / P90 | 列表全量 → 刷新 | 历史下载 | 路由 | 机房 |
|---|---|---|---|---|---|---|
| wifi-relay（强制 relay） | 1716.6 / 3060.4 ms | 1095.0 / 1437.2 ms | 592.9 → 634.9 ms（33 会话，3/3 confirmed） | 2595 ms | 全部 relay | PIT, EWR |
| wifi-auto（自动） | 1958.4 / 3747.5 ms | 923.3 / 1334.6 ms | 1232.8 → 818.0 ms（33 会话，3/3 confirmed） | 4475 ms | 全部 relay（`directRoutes=[]`） | PIT, EWR |

分阶段中位：`wifi-relay` `tcpMs` 8.4 / `outerTLSMs` 675.2 / `upgradeMs` 1085.3 / `innerTLSMs` 1711.3 / `totalMs` 1711.4；`wifi-auto` 8.0 / 615.4 / 1018.1 / 1937.4 / 1937.4。能力集两场景一致：`historyDeflate, mux, ping, sessionsKnown, watchStream`，`legacyHost=false`、`multiplexed=true`（本轮 Mac 没有可广播地址，因此仍无 `lan`）。

逐轮冷开（毫秒）：`wifi-relay` 3060.5、1716.6、1330.6、2251.9、1574.9；`wifi-auto` 3747.5、1640.3、1958.4、2564.2、1946.6。

## 与第二轮的对照

| 指标 | 第二轮 `20261110T033802Z` | 第三轮 `20261110T084031Z` |
|---|---|---|
| relay 探针 `relayWaitMs` | 600 | **0** |
| relay 探针中位 `total` / `upgrade` / `tls` | 1562.1 / 1561.9 / 528.3 ms | 941.9 / 941.7 / 536.2 ms |
| offline-probe（`wifi-relay`） | 2765.9 ms | **1371.6 ms** |
| offline-probe（`wifi-auto`） | 3478.0 ms | **1855.4 ms** |
| R7 判定 | fail（最慢 3478 ms > 3000） | **pass**（最慢 1855.4 ms） |
| 冷开中位 / P90（`wifi-relay`） | 2369.7 / 3742.8 ms | 1716.6 / 3060.4 ms |
| 冷开中位 / P90（`wifi-auto`） | 2459.3 / 2854.9 ms | 1958.4 / 3747.5 ms |
| 热请求中位 / P90（`wifi-relay`） | 1210.2 / 1530.1 ms | 1095.0 / 1437.2 ms |
| 热请求中位 / P90（`wifi-auto`） | 1022.7 / 2350.5 ms | 923.3 / 1334.6 ms |
| 列表全量 → 刷新（`wifi-relay`） | 929.1 → 810.3 ms | 592.9 → 634.9 ms |
| 列表全量 → 刷新（`wifi-auto`） | 1061.3 → 1289.5 ms | 1232.8 → 818.0 ms |

结论：

1. **R7 的两处修复都生效**。relay 侧的宽限取消使探针 `relayWaitMs` 变 0，手机侧的 settle 改动让离线答复只等一条 lane：offline-probe 从 2.77–3.48 s 降到 1.37–1.86 s，两个样本都通过 3000 ms，且没有改动门限。
2. **冷开也一起变快了**：`wifi-relay` 冷开 P90 从 3742.8 ms 降到 3060.4 ms（该轮中位 1716.6 ms，是三轮最低）。relay 探针的 `total` 中位也从 1562.1 ms 降到 941.9 ms，说明这段出境路径本轮更顺；`wifi-auto` 的 P90 反而变高（3747.5 ms），由单轮 3747.5 ms 的样本主导，中位仍然更低。
3. **`wifi-auto` 与 `wifi-relay` 依旧没有直连尝试**（`directRoutes=[]`，`phase=open` 失败直连 0 次），第二轮的结论保持：Mac 不在同一局域网时两者分布重合。

## 过程中出现的两个环境问题（不影响上面的结论，但需要记录）

1. **`wifi-relay` 阶段前两次尝试，冷开都失败**（第一次 5/5，有原始日志；第二次的数量是事后手写记录，**未经核实**）：错误都是 `I/O on closed channel`、约 31.1 s 后报错（原因未定位；"≈ 内层握手 30 s 超时"的归因已由核验者撤回，见下方更正），而同一次运行的 catalog（15.2 s / 33 会话）、三次 confirmed 刷新、history（945 ms）都正常，`done.failures=5`。第一次的原始输出保留在 `logs/attempt1-netbench-wifi-relay.tail.txt`；第二次（09:15Z）据手写记录表现相同，其文件随后被成功那次覆盖，数量只记在 `logs/attempt2-note.tail.txt`（无法与原始输出核对）。
   - 期间的旁证：`wrangler tail scry-relay` 在同一窗口出现 8 次 `[relay] host leg authed mode=run`，说明 Mac 的 host leg 在反复重连；relay 对设备侧报的是 `hostLeg=FOUND waitedMs=0`，即 relay 认为 host 在线并把字节转发出去，而手机的内层握手没有回应，直到 30 s 超时。这与"host leg 陈旧、relay 仍判活"的现象一致，是 relay/host 存活判定的覆盖空白，不是本轮三处改动能引入的行为（本轮 phone 侧只改了 `settle`，relay 侧只改了宽限预算）。
   - 同一构建、同一 relay 在 08:58Z、09:17Z、09:20Z 三次手工 `--console` 运行全部 `failures=0`（`logs/diag-netbench-console.tail.txt`），随后两个正式阶段也 `failures=0`。因此我把它记为**未定位的间歇问题**，没有改代码：现有证据不足以区分"host leg 陈旧"与"设备侧握手在特定时序下不推进"，需要在 relay 侧记录 leg 的打开/关闭与转发失败。
   - **核验者更正（见 `TASK.md`「第三轮核验结论」）**：上面"约 31 s ≈ 内层握手 30 s 超时"和"host leg 陈旧"的归因不成立，已撤回。内层握手超时在手机上报 `timedOut(lane-handshake)`，这里报的却是 `I/O on closed channel`，与外层建连（TCP + 外层 TLS + WebSocket 升级）的 10 s 看门狗一致；31.1 s 也等于 3 次 × 10 s 加 0.25 s + 0.8 s 重试间隔。这是**推断**：失败那次的分阶段计时没有留下，卡在外层哪一段、是否另有原因都未证实。结论是**未定位的间歇性失败**，不是已修复。验证脚本已改为保留失败运行的计时，下次复现即可定位。
2. **设备与负载**：iPhone 两次从 USB 上消失（`devicectl` 报 `unavailable`，`system_profiler` 看不到 iOS 设备），一次 `devicectl` 启动被拒（`invalid code signature … profile has not been explicitly trusted`，重新在手机上信任后恢复）；同一时段 `load average` 一度到 168，一次从设备拷结果的循环卡住超过 15 分钟，直到我 `kill -9` 卡住的阶段。这些都需要人工插入 USB 或解锁，不是代码问题。

## 未验证项与原因

- `install-mac`：按 TASK 本轮不跑（Mac 产物无变化）。
- `ios-checks`：仍是那 4 条自测夹具失败（`catalog.followUp.routingDoesNotResumeAnotherProfile`、`catalog.recovery.explicitModelChoice`、`catalog.model.explicitAutoIsRemembered`、`catalog.model.catalogRecoveryRestoresReadiness`）。按 TASK 复制了第二轮的基线对照日志到本轮 `logs/control-base-ios-checks.tail.txt` 并 `mark-baseline`，R1 因此通过。修这 4 条夹具属另开任务。
- R5 直连、蜂窝场景、Mac 合盖唤醒、大会话历史：前提不成立或未授权，未执行。Linux：未运行。

## 最终判定

- `summarize.mjs` Verdict：**incomplete**。按每个阶段的最后一次运行，必需规则里没有失败项（`wifi-relay` 前两次失败不在其中，见上文「判定」）；`R5-direct` blocked（Mac 不在手机所在局域网），`R7-offline-fast` 已通过。规则表全文见同目录 `SUMMARY.md`。
- 一句话：第三轮的两处修复都按预期生效——relay 立即回 `4001`（`relayWaitMs` 600 → 0），手机只等一条 lane，离线答复 1.37–1.86 s，R7 通过且门限未动；冷开 P90 同时从 3742.8 ms 降到 3060.4 ms。唯一遗留是过程中两次冷开全部失败的间歇现象（约 31 s 后报 `I/O on closed channel`，原因未定位；第一次 5/5 有原始日志，第二次的数量未经核实），定位需要失败那次的分阶段计时（见 `TASK.md` 第三轮核验结论）；如何计入验收由维护者决定。
