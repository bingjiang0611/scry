# 本机验证任务书：iOS 远程连接改造（PR bingjiang0611/scry#52）

执行者：在维护者 macOS 宿主上运行的 Agent，可以访问已配对、已连接的 iPhone。核验者：云端会话（编写这些改动的 Agent）。两边只通过本分支交换信息，目标是一次跑完、自主修复、尽量少回问。

- 分支：`claude/ios-remote-connection-issues-o7oj6x`（不要推到 main，不要改 PR 的草稿状态，不要合并）。
- 背景与协议说明：`docs/remote-network-measurement.md`。本文只写怎么执行、怎么判定、交回什么。
- 已有证据（不必重复证明）：macOS CI 在 `edd56b9` 上已通过 `swift test`、Swift 构建和 iOS 产品 App 编译；Linux 上已通过 Node 单测和 relay smoke。

## 第四轮（2026-11-10，Mac 与手机同一 Wi-Fi，判定 R5）

维护者确认 Mac 和手机现在在同一个 Wi-Fi 上。本轮目标是拿到 R5 的判定；其余规则在当前代码上复核一遍。

- **先同步分支**：分支历史为清除个人标识重写过（强推）。开始前执行 `git fetch origin claude/ios-remote-connection-issues-o7oj6x && git reset --hard origin/claude/ios-remote-connection-issues-o7oj6x`。本地如有未推送的改动，先另存再重置。
- **跑全量** `all`，用新的时间戳。第三轮之后 App、iOS 和 Swift 传输层的代码都有改动（main 的合入、`RelaySession.settle`、`mux_busy` 退避、唤醒后刷新 relay），所以 `install-mac`、`build-ios`、`install-ios` 都要重新执行，不能沿用旧产物。relay（`cf-relay/`）自第三轮以来没有改动，**不需要重新部署**。
- 结果目录现在会先做安全检查（`verify/private-dir.mjs`）：从 `/` 到结果目录的每一层只能属于当前用户或 root，并且其他账户不能写；路径里不能有 `.`、`..`，也不能经过非 root 的符号链接。默认路径在仓库内，一般不会触发。如果被拒绝，按错误信息修正 `SCRY_VERIFY_RESULTS`，不要绕过检查。
- **R5 的预期**：`wifi-auto` 的 `environment.localNetwork=true`，Mac 广播了至少一个局域网地址，并且至少有一条隧道走 `direct`；从第二轮冷开起应当走直连。
- **R5 不通过时**，依次检查以下几项，并把证据写进 REPORT：
  1. `lsof -nP -iTCP:47820 -sTCP:LISTEN` 是否有 Scry 在监听；如果设置了 `SCRY_REMOTE_LAN=0`，监听会被关闭。
  2. macOS 防火墙是否放行 Scry。
  3. iOS「设置 → 隐私与安全性 → 本地网络」里是否允许了 ScryRemote。
  4. `wifi-auto` 原始输出中的 `directRoutes`，以及每次直连尝试的错误。
  5. 两台设备是否真在同一网段。注意访客网络或开了「AP 隔离」的 Wi-Fi 会阻止设备互访，这种情况记为环境限制，判 blocked，不算缺陷。
- 同时记录 R5b：打开连接的路径上（`phase=open`）不应出现失败的直连尝试。
- 其余要求不变，按下文执行：不改门限，不跳过规则；同一个失败修两次仍不行就停下，把证据写进 REPORT；结果和 REPORT 推送到本分支。

## 第三轮核验结论（核验者，2026-11-10）

- 结果 `results/20261110T084031Z` 与原始数据一致，没有本机修复，规则和门限未动。R7 通过（1371.6 / 1855.4 ms），两处修复在真机上都生效（relay 探针 `relayWaitMs` 600 → 0）。除 R5 外所有必需规则通过；R5 blocked 是环境前提（Mac 不在手机所在 Wi-Fi），不是缺陷。
- **对两次"5/5 冷开约 31 s 失败"的诊断需要更正**：REPORT 把它归因为 host leg 陈旧、内层握手无应答，但数值和错误类型不支持这个结论。内层握手超时在手机上报的是 `timedOut(lane-handshake)`，显示为超时文案；而这两次报的是 `I/O on closed channel`。后者与外层建连的 10 s 看门狗一致（`TransportConnection.swift`：TCP + 外层 TLS + WebSocket 升级必须在 10 s 内完成，否则关闭通道）。每轮 31.1 s 恰好等于 3 次 × 10 s 加 0.25 s + 0.8 s 的重试间隔。由此**推断**卡住的是手机到 Cloudflare 的外层建连（TCP、外层 TLS 或升级三者之一），而不是 Mac 的 leg；当时 relay 日志里的 `hostLeg=FOUND` 应来自其他成功的连接。这只是根据错误类型和总时长得出的推断：失败那次的分阶段计时没有保留，具体卡点和是否另有原因都**未证实**，结论仍是"未定位的间歇性失败"。REPORT 中相应段落已加核验者更正。
- 卡在外层哪一段，需要失败那次的分阶段计时；这次被成功的重跑覆盖了。`local-verify.sh` 已改为：重跑前把旧的原始输出改名保留，失败的运行另存一份带隧道计时的 `logs/netbench-<场景>.failed-<时间>.tail.txt`。
- 以后再复现时，交回这份文件即可：看失败记录里 `tcpMs`、`outerTLSMs`、`upgradeMs` 停在哪一段，再决定改手机网络层（Network.framework 等待策略）还是查 relay 入口。在拿到这份证据之前，不改超时，也不改重试次数。

## 第三轮（2026-11-10，基于第二轮结果 `results/20261110T033802Z`）

第二轮的核验结论：报告与数据一致；3 个本机修复（`a6b2b68`、`bbfbf39`、`8d6c104`）都正确，各有回滚即失败的测试，没有放宽任何规则。R3、R5b、R6 的规则缺陷和 host 广播缺陷都已消除。唯一失败的 R7 是真实的时延问题（不是规则问题），本轮代码已修复两处，3000 ms 门限不变：

| 第二轮现象 | 根因 | 本轮改动 |
|---|---|---|
| 每个离线样本都带 `relayWaitMs=600`，包括从没有 host 进过的随机房间 | relay 对"没有存活 leg"一律先等 600 ms 宽限 | `ce3f5fe`：只有 10 s 内有 host leg 打开、认证或关闭时才等宽限，否则立即 `4001`。**需要重新部署 relay 才生效** |
| 离线答复取两条 lane 中较慢的那条（例：2.45 s 与 3.27 s） | `prewarm()` 等两条 lane 都结束；task group 的 `cancelAll` 也要等子任务，所以第二轮那次尝试无效 | `d3ee35a`：任一 lane 收到 `4001` 就立即返回，另一条在后台自行结束；其他错误仍等两条都结束 |

预期：离线探测约等于一条 lane 的"外层 TLS + 升级 + 关闭帧"，不再含 600 ms 宽限，按第二轮的路径数据约 1.2–2.3 s。Mac 侧代码本轮没有改动（`git diff 7ccd437 -- src` 为空），**不需要重装或重启 Scry**，只要 Scry 在运行。

### 第三轮步骤（新时间戳；前两轮结果目录保持原样）

**用户已于 2026-11-10 在会话中授权重新部署线上 relay**（`wrangler deploy`，与第一轮相同的 Worker），本轮不用再问。部署失败（例如 Cloudflare 未登录）时，只有手机侧修复生效，照常执行并在 REPORT 里注明 relay 未部署；R7 仍以实测为准，不改门限。

```bash
git pull --ff-only
```

```bash
export SCRY_IOS_BUNDLE_ID=com.scry.remote.local SCRY_VERIFY_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
```

部署 relay：

```bash
(cd experiments/remote-g0/cf-relay && npx --prefix .. wrangler deploy)
```

```bash
experiments/remote-g0/verify/local-verify.sh env && experiments/remote-g0/verify/local-verify.sh checks
```

- `ios-checks` 如果和第二轮一样失败：把 `results/20261110T033802Z/logs/control-base-ios-checks.tail.txt` 复制到本轮 `logs/`，再执行 `local-verify.sh mark-baseline ios-checks logs/control-base-ios-checks.tail.txt`。失败内容不同则按 §4 处理。
- 本轮不跑 `install-mac`（Mac 产物没有变化）。

```bash
experiments/remote-g0/verify/local-verify.sh build-ios && experiments/remote-g0/verify/local-verify.sh install-ios
```

```bash
experiments/remote-g0/verify/local-verify.sh relay-probe mac && experiments/remote-g0/verify/local-verify.sh netbench wifi-relay -netBenchRoute=relay -netBenchRounds=5 && experiments/remote-g0/verify/local-verify.sh netbench wifi-auto -netBenchRounds=5 && experiments/remote-g0/verify/local-verify.sh summarize
```

预期结果：

- R1、R2、R3、R4、R5b、R6、R7 通过；R5 在 Mac 不在手机所在 Wi-Fi 时为 blocked。
- 部署生效的证据：`relay-probe-mac.jsonl` 的 `relayWaitMs` 为 0（第二轮是 600；探针连的也是没有 host 的房间）。
- R7 仍失败时，不要改门限，也不要改 lane 生命周期；在 REPORT 里给出每个 `offline-probe` 样本的耗时、同一时段 relay 探针的 `tls`/`upgrade`/`upgradeExcludingWait`/`relayWaitMs` 中位数，以及 relay 是否已部署，由核验者决定下一步。

交回内容同 §6，REPORT 额外写一节"与第二轮的对照"：`offline-probe` 每个样本耗时、relay 探针的 `relayWaitMs`，以及冷开 P90。

## 第二轮（2026-11-10，基于第一轮结果 `results/20261109T155516Z`）

第一轮的核验结论：报告与数据一致，5 个修复提交都正确，没有放宽任何规则。原始数据还暴露了一个真实缺陷，另外有两条规则本身有缺陷。本轮代码已修复：

| 第一轮现象 | 核验结论 | 本轮改动 |
|---|---|---|
| R5 失败：Mac 广播了 `172.18.0.1`（utun13）和 `192.168.255.254`（utun5，/32），手机每条隧道先等 2×900 ms 才走 relay；`wifi-auto` 第 1 轮冷开 3420 ms，`diag-order` 3720 ms | **产品缺陷**：VPN 和点对点隧道的地址不该广播；没有确认过的直连地址也不该挡在打开连接的路径上 | host 不再广播 VPN、隧道、虚拟网卡上的私网地址，也不广播 /32 地址；100.64/10 的 overlay 地址照常广播。手机只在路由已经在当前网络确认过时才先试直连，没确认的只在后台升级时尝试；切换网络后清空确认记录 |
| R6 失败：刷新比全量慢 | **规则缺陷**：链路往返约 620 ms、抖动大，每项只测 1 次，无法区分；测量时 App 自己的首页也在并发请求（诊断里出现了第二个 RelaySession） | `-netBench` 运行时不加载 App 主界面；刷新测 3 次，并记录 host 是否确认"未变化"（`confirmed`）。R6 改为判定 3 次刷新都被确认，耗时只作参考 |
| R7 blocked：Agent 运行在 Scry 里，没法退出 Scry | 只是测量方式的限制 | `-netBench` 增加离线探测：用同一套配对凭据连接一个没有 host 的房间，不用退出 Scry；R7 以此为证据 |
| ios-checks、install-mac 失败，都能在基线上复现 | 不是本分支引入的 | 新增 `local-verify.sh mark-baseline <阶段> <对照日志>`：必须提供基线对照日志，R1 才会把它列为已知基线问题，而不是判为失败 |

新增规则 **R5b**：任何场景下都不能出现"在打开路径上（`phase=open`）失败的直连尝试"。这条直接验证上面的缺陷已修复。

### 第二轮步骤（时间戳用新的；第一轮结果目录保持原样）

开始前只问用户一次，内容如下：

1. 新的 Mac 构建装好后，请用户**手动退出并重新打开 Scry**（Agent 运行在 Scry 里，不能自己重启）。
2. （可选，用于判定 R5）能否让 Mac 和手机连同一个 Wi-Fi？不能的话，R5 判为 blocked 即可，不算失败。

然后依次执行：

```bash
git pull --ff-only
```

```bash
export SCRY_IOS_BUNDLE_ID=com.scry.remote.local SCRY_VERIFY_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
```

```bash
experiments/remote-g0/verify/local-verify.sh env && experiments/remote-g0/verify/local-verify.sh checks
```

- `ios-checks`、`install-mac` 如果和第一轮一样失败，先在基线 worktree（`5760dd7`）上复现，把对照日志放进本轮结果目录的 `logs/`，再执行 `local-verify.sh mark-baseline <阶段> logs/<对照日志>`。如果失败内容和第一轮不同，按 §4 处理。
- install-mac：用和第一轮相同的手工 pack 步骤装到 `/Applications/Scry.app`，然后请用户重启 Scry。重启后的确认方式：`lsof -iTCP:47820 -sTCP:LISTEN` 显示由 `/Applications/Scry.app` 持有。

```bash
experiments/remote-g0/verify/local-verify.sh build-ios && experiments/remote-g0/verify/local-verify.sh install-ios
```

```bash
experiments/remote-g0/verify/local-verify.sh relay-probe mac && experiments/remote-g0/verify/local-verify.sh netbench wifi-relay -netBenchRoute=relay -netBenchRounds=5 && experiments/remote-g0/verify/local-verify.sh netbench wifi-auto -netBenchRounds=5 && experiments/remote-g0/verify/local-verify.sh summarize
```

预期结果：

- R2、R3、R4、R5b、R6、R7 都通过。R7 依据 `offline-probe`：`hostOffline=true` 且耗时 ≤3000 ms。
- R5：Mac 不在手机所在的 Wi-Fi 时为 blocked（Mac 没有可广播的地址）；同一 Wi-Fi 时应通过，并且第二轮以后的冷开走直连。
- 任何一条与预期不符，先按 §4 自主处理，再写进 REPORT。

交回内容同 §6，REPORT 额外写一节"与第一轮的对照"：冷开 P90，以及 `wifi-auto` 和 `wifi-relay` 的差距是否消失。

## 1. 完成定义

`experiments/remote-g0/verify/summarize.mjs` 对你的结果目录给出 `Verdict: pass`；或者给出 `incomplete`/`fail`，但每一条未通过的规则都在 `REPORT.md` 里写明了根因、你做过的尝试，以及需要谁做什么决定。规则的含义见 §5。

## 2. 开工时只问用户一次（合并成一个问题）

1. **能否退出并重新打开 Scry？** 新的 host 代码只有重启后才生效，`host-quit` 场景也需要退出 Scry。同意后设置 `SCRY_VERIFY_ALLOW_RESTART=1`。不同意的话，请用户自己重启一次，并跳过 `host-quit`。
2. **签名团队 ID** `SCRY_IOS_DEVELOPMENT_TEAM`（环境里已有就不用问）。手机需要解锁、已信任这台 Mac，并和 Mac 在**同一个 Wi-Fi** 上。
3. **是否授权部署线上 relay？**（`wrangler deploy`，外部写操作，需要 Cloudflare 登录）不授权也不影响其余验收，R7 会显示为 blocked。
4. （可选）是否配合测蜂窝场景：测之前请用户关闭手机 Wi-Fi，测完再打开。

其余事情都不再询问，自己处理。

## 3. 执行

```bash
git fetch origin claude/ios-remote-connection-issues-o7oj6x && git checkout claude/ios-remote-connection-issues-o7oj6x && git pull --ff-only
```

```bash
SCRY_VERIFY_ALLOW_RESTART=1 SCRY_IOS_DEVELOPMENT_TEAM=<team> experiments/remote-g0/verify/local-verify.sh all
```

`all` 依次执行：`env`、`checks`（typecheck、Node 单测、remote-g0 测试、relay smoke、`swift test`、iOS 离线检查）、`install-mac`（`npm run install:mac:dev`）、`restart-mac`、`build-ios`、`install-ios`、`relay-probe mac`、`netbench wifi-relay`、`netbench wifi-auto`、`host-quit`、`summarize`。结果写入 `docs/handoff/ios-remote-verification/results/<UTC 时间戳>/`。任何阶段都可以单独重跑；单独重跑时设置 `SCRY_VERIFY_STAMP=<同一个时间戳>`，结果会写进同一目录。

授权了 relay 部署时，在 `all` 之后执行：

```bash
cd experiments/remote-g0/cf-relay && npx --prefix .. wrangler deploy
```

然后重跑 `relay-probe mac-after-deploy`、`host-quit` 和 `summarize`（同一个时间戳）。

用户同意测蜂窝时：请用户关掉手机 Wi-Fi，跑 `netbench cellular-auto -netBenchRounds=5`，结束后请用户重新打开 Wi-Fi。

## 4. 自主修复规则

出现失败时，按"定位根因 → 最小修复 → 重跑失败的阶段 → 重跑 `summarize`"循环处理，不要每一步都回来问。

- **可以直接修**：本分支改动过的文件（`git diff 5760dd7 --stat` 中列出的文件）里的编译错误和运行时缺陷；`verify/` 下脚本在你的 Xcode 版本上的 CLI 参数差异；测试本身的错误。每个修复单独提交，提交说明写清现象、根因和验证方法。
- **不能改，只能记录为阻碍**：认证、授权和信任语义（inner mTLS、设备授权、局域网监听的暴露范围与默认值）；为了让判定变绿而放宽 `summarize.mjs` 的规则或阈值；跳过或禁用测试；改性能门限；部署未授权的 relay。
- 同一个失败修两次仍然不行，就停止这一项，把证据写进 REPORT，继续做其他阶段。
- 手机丢失配对（例如签名团队变了，Keychain 不能沿用）时，请用户在 Mac 上用二维码重新配对。这是唯一允许追加的提问。
- 遵守 CLAUDE.md：提交身份必须是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`；每个提交都要通过 20KB 暂存文件门禁（结果目录已经按此处理：完整日志和原始数据在 gitignore 的 `raw/` 与 `logs/*.log` 中）；证据要如实，测不到就写 unavailable，不能写成 0。

## 5. 判定规则（由 summarize.mjs 自动执行）

| 规则 | 含义 |
|---|---|
| R1-checks | 所有执行过的检查阶段都通过；用 `mark-baseline` 记为已知基线的阶段不算失败（这条豁免由核验者制定，待维护者确认） |
| R2-netbench-clean:\<场景\> | 场景跑完（有 `done` 事件）且 failures=0 |
| R3-transport:\<场景\> | 手机已切到复用模式，host 声明了 ping、mux、watchStream、sessionsKnown、historyDeflate。不通过通常说明 host 没在新版本上重启 |
| R4-relay-only | `wifi-relay` 场景全部走 relay |
| R5-direct | `wifi-auto` 场景在本地网络下至少有一条直连隧道。不通过时先查 macOS 防火墙是否放行 Scry 监听 47820 端口，以及 iOS"本地网络"权限 |
| R6-catalog:\<场景\> | 会话列表"未变化刷新"不慢于全量遍历（容差 20%+50ms） |
| R7-offline-fast | relay 部署后，退出 Scry 时手机在 3 秒内得到"Mac 当前不在线"；未部署时显示为 blocked |
| I1–I3 | 仅供参考：直连与 relay 对比、与 baseline 对比、relay 路径和机房 |

## 6. 交回内容（提交并推送到本分支）

1. 结果目录 `docs/handoff/ios-remote-verification/results/<时间戳>/`：`env.txt`、`checks.json`、`logs/*.tail.txt`、`netbench-*.jsonl`、`relay-probe-*.jsonl`、`summary.json`、`acceptance.json`、`SUMMARY.md`。
2. 同一目录下的 `REPORT.md`，按 `REPORT-TEMPLATE.md` 填写。
3. 你做的修复提交（与结果提交分开）。
4. 推送完成后，在会话里只需告诉用户一句："本机验证已推送到分支，时间戳 X，判定 Y"。核验者会从分支读取全部内容。

## 7. 注意

- 手机上运行的是 Debug 版，`-netBench` 只读，使用手机已有的配对，不写 host。
- 安装 Mac App 不会更新正在运行的进程，必须重启 Scry。
- 不要为了测速给测试加 sleep、重试或放宽超时；毫秒数据只代表这台机器和这个网络当下的情况（L2），报告里要写明网络环境。
