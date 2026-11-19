# W1 · macOS 真机基线

## 目标

在维护者的 Mac 上，对分支当前提交确认三件事，作为后续所有合并的门槛：

1. `main` 已合入的「打包版默认 daemon 模式」（`c35d0191`）在真机上可用。
2. 分支上 `main` 之后的代码改动在真机上没有回归：P5-0（supervisor 停止等待、`SHELL`、版本来源、服务模板只渲染）、配对记录清理、iOS 协议版本修复（`172074a2`）。
3. 上一轮（`f96e8eb`）被阻塞的项目全部有结论。

参考：上一轮收口 [b4-s0-final](../../status/b4-s0-final.md)、流程细节 [b4-s0-macos-2](../../status/b4-s0-macos-2.md)、[b4-s0-providers](../../status/b4-s0-providers.md)、[b4-s0-scenarios](../../status/b4-s0-scenarios.md)、[b4-s0-packaged](../../status/b4-s0-packaged.md)、[b4-s0-performance](../../status/b4-s0-performance.md)。

## 先决

- 记录：提交 SHA、macOS 版本、芯片、系统语言、Node 版本、Codex 与 Qoder CLI 版本、Xcode 版本。
- 用短的独立临时目录：`export TMPDIR=$(mktemp -d /tmp/w1.XXXX)`（上一轮安装门禁失败，怀疑过长的 TMPDIR 让 unix socket 路径超过 104 字节）。
- 依赖：`QODER_SKIP_DOWNLOAD=1 npm ci`。

## 项目与验收

| # | 项目 | 验收标准 | 自验命令 / 做法 |
|---|---|---|---|
| 1 | 安装门禁 | `npm run install:mac:dev` 退出 0；装到 `/Applications/Scry.app`（验证轮次的覆盖安装此前已获维护者授权；维护者另有指示时以其为准。安装前确认日常 App 已退出，失败不得留下半成品；装完由维护者自行重启日常 App） | 完整日志 tee 到证据目录；失败时保存失败测试名、断言全文、TMPDIR 与 socket 路径长度 |
| 2 | 单元与类型 | `npm run typecheck`、`npx vitest run src/daemon src/main/remote src/cli` 全过 | 失败先看是否既有失败（对照 `main`） |
| 3 | `workspace-init` 测试 | 上一轮失败的 daemon 快路径测试通过；若仍失败，记录 TMPDIR 长度并判断是否 socket 路径问题 | `npx vitest run src/cli/workspace-init` |
| 4 | 打包产物 smoke | `npm run check:packaged-app`、daemon-mode smoke、打包 recorder smoke 通过 | 见 b4-s0-packaged 的命令 |
| 5 | 默认 daemon 实测 | 正式包不设 `SCRY_HOST_DAEMON` 时走 daemon；设 `=0` 回到进程内；两种都能发送、流式、停止 | App 设置页「后台服务」状态 + 进程树 |
| 6 | 真实 Codex | daemon 模式下 4 轮对话：工具调用、批准、拒绝、停止、恢复会话、原生分支、turn diff、recorder 记录与 SHA-256、> 4 MiB 的大 trace 能打开 | 用临时工作区；流程同 b4-s0-providers |
| 7 | 真实 Qoder | 同 #6 的发送与停止；若仍是 `sdk_worker_removed`，记录 CLI 版本与 stderr 即可（已知问题） | — |
| 8 | B4-V 场景 | `node scripts/b4v-scenarios.mjs` 全部场景通过（含 sigkill、upgrade、quit-all、reopen、trust-gate、mutual-exclusion、renderer-isolation、close-app） | 报告 JSON 存证据目录；对话框只用 AX 动作 |
| 9 | P5-0 停止等待 | 有 run 运行时「退出 Scry 与后台服务」：daemon 在 25 s 内收尾退出，`daemon.lock` 与 socket 不残留，终端录制已收尾；「重启后台服务」后 run 状态正确 | 记录 supervisor 与 daemon 的退出时间差 |
| 10 | 服务模板（只渲染） | 用 `src/daemon/supervisor-templates.ts` 渲染一份 plist 到证据目录，`plutil -lint` 通过；路径含中文与空格时值不变 | **不要** `launchctl bootstrap`，不要写 `~/Library/LaunchAgents` |
| 11 | 会话打开测速 | 空闲 Mac（1 分钟负载 < 核数）上 `node scripts/session-open-bench.mjs <场景>` 与加 `--daemon`，四个场景（markdown、short、short-heavy、paged）各跑一次 | 失败时保存完整 stderr（含 `SCRY_NATIVE_FAILURE` 行），并导出所有 `session_history.load` trace 及其 outcome；上一轮的 `returnedTurns` TypeError 与 `button.sb-sess` 超时是否复现 |
| 12 | 约 100 分钟长跑 | daemon 模式下 App 连续运行约 100 分钟，期间每 10 分钟一轮 Codex 短对话；无崩溃、无内存持续增长、无卡死 | 记录 daemon 与 App 的 RSS 曲线 |
| 13 | 真实数据 A/B | 退出日常 App 后做副本，daemon 模式与 `SCRY_HOST_DAEMON=0` 逐项一致：token、turns、toolCalls、projects、用量统计 | 方法同上一轮（`sqlite3 .backup` + rsync，排除 `Singleton*`）；做完重新打开日常 App |
| 14 | iOS 协议修复 | `cd experiments/remote-g0/swift && swift test` 通过，含 `ProviderDiscoveryTests` | — |
| 15 | iOS 真机 | 开发签名覆盖安装到 iPhone 13（已授权，**不要**重置配对）；Provider 列表与所选 Provider 的控制项能加载（`172074a2` 修复的就是这个）；三处输入回归（选文件夹、发送箭头、模型列表滚动）；远程发送一轮 | iPhone 或 iCTRL 不可用就标受阻，继续其他项 |
| 16 | 配对清理 | 已配对的 iPhone 在新版本上仍能连接；连续生成 70 次邀请（可用测试 userData）后新邀请仍成功 | 用测试实例做 70 次，不在日常 userData 上做 |

## 停止条件

- 第 1 项失败：先取证并判断。若是测试本身的环境脆弱（如路径长度），可以修测试并单独提交；若是产品问题，写清证据后继续其他不依赖安装的项目（2、3、14 等），并在报告里给出根因或排序后的假设。
- 维护者设备（iPhone、iCTRL）不可用：对应项标受阻，不等。

## 报告

`reports/W1.md`，按 [README](../README.md) §3 的格式。总结论里明确写：「默认 daemon 在 macOS 真机上是否可以作为合并门槛通过」。
