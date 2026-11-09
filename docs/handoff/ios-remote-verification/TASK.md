# 本机验证任务书：iOS 远程连接改造（PR bingjiang0611/scry#52）

执行者：在维护者 macOS 宿主上运行的 Agent，可以访问已配对、已连接的 iPhone。核验者：云端会话（编写这些改动的 Agent）。两边只通过本分支交换信息，目标是一次跑完、自主修复、尽量少回问。

- 分支：`claude/ios-remote-connection-issues-o7oj6x`（不要推到 main，不要改 PR 的草稿状态，不要合并）。
- 背景与协议说明：`docs/remote-network-measurement.md`。本文只写怎么执行、怎么判定、交回什么。
- 已有证据（不必重复证明）：macOS CI 在 `edd56b9` 上已通过 `swift test`、Swift 构建和 iOS 产品 App 编译；Linux 上已通过 Node 单测和 relay smoke。

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
| R1-checks | 所有执行过的检查阶段都通过 |
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
