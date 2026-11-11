# 本机验证任务书：iOS 远程连接改造（PR bingjiang0611/scry#52）

执行者：在维护者 macOS 宿主上运行的 Agent，可以访问已配对、已连接的 iPhone。核验者：云端会话（编写这些改动的 Agent）。两边只通过本分支交换信息，目标是一次跑完、自主修复、尽量少回问。

- 分支：`claude/ios-remote-connection-issues-o7oj6x`（不要推到 main，不要改 PR 的草稿状态，不要合并）。
- 背景与协议说明：`docs/remote-network-measurement.md`。本文只写怎么执行、怎么判定、交回什么。
- 已有证据（不必重复证明）：macOS CI 在 `edd56b9` 上已通过 `swift test`、Swift 构建和 iOS 产品 App 编译；Linux 上已通过 Node 单测和 relay smoke。

## 第四轮核验结论与第五轮（核验者，2026-11-10，基于 `results/20261110T153956Z`）

结论：SUMMARY 与原始数据一致，门限未动。修复提交 `8ec746a5` 正确，保留：它让手机在复用已记住的能力时，仍在后台读一次 host 的局域网广播。代价是每打开一条多路复用隧道多一次 ping；首次打开时这次 ping 与打开路径上的那次重复，可以忽略。报告里有三处结论需要更正或降级：

- **R2 的 31 s 卡顿：「旧中继腿」的推测与数据不符，撤回。** 失败那次留下了分阶段计时（`logs/netbench-wifi-relay.failed-162247Z.tail.txt`）：16:19:54–16:22:30 共 31 次打开尝试，两条 lane 同时失败，每次约 10.0 s 后 `I/O on closed channel`，并且**都没有 `tcpMs`**。也就是说，手机到 Cloudflare 的 TCP 连接一次都没建立，relay 根本没收到连接，relay 或 host 的腿状态不可能是原因。16:22:40 起恢复正常（`tcpMs` 6.7 ms）。同一窗口内 offline-probe 用了 6656 ms。"卡在 TCP 之前"是数据直接显示的；"原因在手机网络层（Network.framework 在 App 重新启动后的一段时间里等待可用路径）"是推断。
- **R5：「Mac 的 en0 是合成网卡」只是推断，未证实。** 依据是 `ether 02:00:00:00:00:00` 加上 ARP 表为空，但受限进程读取网卡信息时也可能看到这样的结果。更关键的是，iOS「本地网络」权限没有核实：没放行时，手机连局域网地址会等待、超时，表现和这次完全一样。所以 R5 失败的原因尚未确定，不能直接记为环境限制。
- **R7：** 3 个样本中最慢的 3277.6 ms 超过 3000 ms，按规则判 fail。运行期间负载 load average 294，推断是机器过载造成的，需要在空闲时重测。**R1：** `install-mac` 因过载被中断，手工打包的证据有效，但 R1 在补跑之前仍是 fail。

新增诊断（本提交）：连接卡住时，Network.framework 会报告它在等待什么（没有可用路径、接口断开、本地网络权限被拒等）。现在每次打开尝试的计时里会记录 `waitingMs`（何时开始等待）和 `waitingReason`（最近一次的原因），失败记录里也有。卡顿和直连失败都可以靠这两个字段判断原因。

### 第五轮执行要求（维护者 2026-11-11 决定：暂不执行，PR 带着下列遗留风险合并）

- **同步分支**：`git fetch origin claude/ios-remote-connection-issues-o7oj6x && git reset --hard origin/claude/ios-remote-connection-issues-o7oj6x`。
- **先确认机器空闲**：`uptime` 的 load average 低于 10 再开始，并把开始时的 `uptime` 写进 REPORT。机器忙的话等它空下来，不要在过载状态下测。
- **先让用户确认两件事并写进 REPORT**：① iPhone「设置 → 隐私与安全性 → 本地网络」里 ScryRemote 已打开；② 在 Mac 自带的终端里（不是 Agent 的 shell）执行 `ifconfig en0 | grep ether` 和 `arp -an | head -5`，原样记录输出。
- **跑全量** `all`，用新的时间戳。传输层代码有改动，iOS App 必须重新编译安装。relay 不用重新部署。
- **R5**：除了 `openErrors`，还要报告直连尝试的 `waitingReason`。如果显示本地网络权限被拒，那是权限问题，不是环境限制。
- **冷开卡顿再次出现时**：引用失败记录里的 `waitingMs` / `waitingReason`。不要改超时，也不要改重试次数，这一点和以前一样。
- 其余要求不变。

## 往轮记录

第二轮到第四轮的执行要求和核验结论在 [`ROUNDS.md`](ROUNDS.md)（按时间倒序）。下面第 1–7 节是每轮都适用的通用规则。

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
| R1-checks | 所有执行过的检查阶段都通过；用 `mark-baseline` 记为已知基线的阶段不算失败（**维护者 2026-11-10 确认保留**；只适用于附了基线对照日志、在 main 基线上同样失败的阶段，REPORT 仍须列出这些失败） |
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
   - 手工加进结果目录的证据文件（`logs/evidence-*.txt` 等）必须在**最后一次 `summarize` 之前**放进去，因为 `summarize` 会先运行 `redact.mjs` 脱敏。提交前再执行一次 `node experiments/remote-g0/verify/redact.mjs <结果目录>`，并用 `git grep` 确认没有账户名、Apple ID、团队 ID 或证书哈希。第四轮的证据文件就是因为漏了这一步，带着账户名和签名身份被提交了。
4. 推送完成后，在会话里只需告诉用户一句："本机验证已推送到分支，时间戳 X，判定 Y"。核验者会从分支读取全部内容。

## 7. 注意

- 手机上运行的是 Debug 版，`-netBench` 只读，使用手机已有的配对，不写 host。
- 安装 Mac App 不会更新正在运行的进程，必须重启 Scry。
- 不要为了测速给测试加 sleep、重试或放宽超时；毫秒数据只代表这台机器和这个网络当下的情况（L2），报告里要写明网络环境。
