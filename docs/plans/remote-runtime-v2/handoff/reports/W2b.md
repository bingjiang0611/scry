状态：受阻

# W2b · P5 第 1 步剩余真机验收报告

## 待维护者操作清单（与 W1 共用）

- [x] **1. 辅助功能（AX）权限验收**：已通过。经维护者同意改为仅授权 `Terminal.app`（不授权 `python3`/`osascript`），以纯 `AXUIElementPerformAction(kAXPressAction)` 完成项 1（及 W1 #8/#9）全部原生确认框验收。
- [ ] **2. 约定项 2（真实注销再登录）与项 4（FileVault 重启）的停机窗口**：
  - 放到最后：待执行方 B、C 停工且确认 `MEASURING` 不存在时，执行方 A 会在对话里提议停机时间，获得维护者确认后再同批执行。

## 1. 结论

**受阻（已完成项 1 原生确认框 AX 验收通过、项 3 开发签名实测完成；现仅余排期至最后的项 2 真实注销再登录与项 4 FileVault 重启待 B/C 停工后约时间，项 5 标 `not-run`）**。全程仅用测试标签与临时服务目录，未触碰日常 `com.scry.daemon` 与 `~/Library/LaunchAgents`。

## 环境信息

- 验证提交：`1cc050f9`（含 W2 第三轮代码通过 `de61be2c`）→ `d10e8b4c`
- 操作系统：macOS 27.0（Build 26A428），Darwin 27.0.0 arm64（Apple M6，12 逻辑核）
- 被测安装包：`/Users/bingjiang/work/scry-A/dist/mac-arm64/Scry.app/Contents/MacOS/Scry`（`codesign`: `Signature=adhoc`、`Identifier=Electron`、`TeamIdentifier=not set`、`CDHash=d7740e6a...` — **开发签名，正式包行为可能不同**）
- FileVault：`fdesetup status` → `FileVault is On.`
- 辅助功能权限：`Terminal.app` 已获 AX 信任（`AXIsProcessTrusted: true`，未给通用解释器授权）
- 证据目录：`~/.local/state/scry-handoff-evidence/W2b/`

## 2. 提交

- 基线：`92a603d4`（移交 W2b）→ `1cc050f9`（含 W6 通过与 W7 评审）
- `97b21cdc` / `9f048b9c`：首版 W2b 状态报告与 W1 #12 后状态更新
- 本报告提交：见本次推送最新 SHA

## 3. 验收逐项

| # | 项目 | 状态 | 关键证据与路径 |
|---|---|---|---|
| 1 | 原生确认框（AX） | **通过** | 在 `Terminal.app` 下以纯 `AXUIElementPerformAction(kAXPressAction)` 驱动 `dist/mac-arm64/Scry.app` 独立测试实例（测试标签 `com.scry.daemon.test.w2b1.54825`，临时服务目录 `/private/tmp/scry-ax-w2b1-nrSSxl/launch agents`，含空格和中文 userData `/private/tmp/scry-ax-w2b1-nrSSxl/测试 用户`，未碰 `com.scry.daemon`）：① 开启点「取消」返回 `cancelled`、`plistAfterCancel: false`、`launchctl print` 退出 `113`（未加载）；② 开启点「开启登录时启动」返回 `done`、`plistAfterConfirm: true`（`0600`）、`launchctl print` 退出 `0`、`loginStart.state: enabled`、`loaded: true`；③ 关闭无确认弹窗（耗时 `4 ms` 返回 `done`）、删除 plist 且运行中 daemon 保持存活；事后 `bootout` 清理、`~/Library/LaunchAgents/com.scry.daemon.plist` 不存在。证据：`W2b/w2b-01-ax-report.json`、`W1/w1-w2b-ax-run.log` |
| 2 | 真实注销再登录 | **未验证（排期至最后）** | 注销会中断当前桌面与所有执行方；待 B、C 全部停工且无 `MEASURING` 时向维护者提议停机时间，获确认后仅用测试标签与临时服务目录执行 |
| 3 | 签名包上的系统权限（TCC `~/Documents`、钥匙串、本地网络） | **已完成开发签名实测（开发签名，正式包行为可能不同）** | 使用 `dist/mac-arm64/Scry.app`（`Signature=adhoc`）+ 测试标签 `com.scry.daemon.test.w2b3.*` + 临时服务目录 + 独立 `userData`，由 `launchd` 无头拉起（`launchedBy: service`，无 App GUI），结束 `launchctl bootout`（441 ms）零残留且临时目录全清（`W2b/w2b-03-permissions-report.json`、`W2b/w2b-03-permissions-r2.log`）：<br>① **TCC（`~/Documents`）**：未事先在 GUI 授「文稿」权限时，`launchd` 拉起的开发签名 daemon 触及 `~/Documents/scry-w2b3-tcc-测试-*` 在内核阻塞等待 TCC（`sample` 栈证实在 `path_helper -> __fts_open -> open$NOCANCEL` 挂起，`W2b/w2b-03-tcc-path-helper.sample.txt`），导致 Codex `initialize` 超时（`Codex app-server request timed out: initialize`）及 daemon 终端读 `~/Documents` 12 s 超时；同 daemon 对照 `/tmp` 工作区 Codex 实跑 `settled` 全过（`matchedToken: true`）。<br>② **钥匙串与登录态**：Codex（`0.170.0`）daemon 实跑对话 `settled`（`matchedToken: true`）且 `codex login status` 退出 0（`Logged in using ChatGPT`）；Qoder `1.1.93 status` 退出 0（`Auth Source: local`）且 SDK 内置 `1.1.11` 真实 `-p` 回复 `QODER_LAUNCHD_OK`（退出 0）；`agy`（`1.5.12`）在隔离空配置目录（无本地 token 文件、强制读 macOS 钥匙串）跑 `agy acp`，`initOk: true`、`sessionNewOk: true`、返回 11 个模型、`promptStopReason: "end_turn"`（因 `launchd` 未设代理返回地区 400，但钥匙串凭据读取已证可用）；`security find-generic-password` 核对 `scry Safe Storage` 与 `antigravity` 均退出 0。<br>③ **本地网络权限**：`RemoteLanListener` 监听 `TCP *:52924`（`47820` 被 C 空闲进程占用，自动回退临时端口），经本机 `en1`（`30.7.224.207:52924`）完成 TLS 1.3 mTLS 握手并收到 `InnerMtlsHost` 响应（`device_not_authorized`，本地 grant 不放行远程 LAN 口符合设计；`30.x` 非 RFC1918/100.64 故未广播）；出站 `224.0.0.251:5353` 与网关 `30.7.224.1:80` 报 `EHOSTUNREACH`，但宿主 Shell 对照同样报 `EHOSTUNREACH`，跨设备 LAN 连通待 iPhone 配对后复验 |
| 4 | FileVault | **未验证（排期至最后，与项 2 同批）** | 已核实 `fdesetup status` 为 `FileVault is On.`；需整机重启，与项 2 同批放到最后 |
| 5 | Linux 真机 | **not-run** | 本机为 macOS 27.0（arm64），无 Linux 真机环境 |

### 当前各执行方状态与测量锁核查（2026-11-20 12:26）

- **`MEASURING` 文件**：当前不存在。
- **执行方 A（`~/work/scry-A` / `exec/A`）**：W6 已通过（`W6-review.md`）；W1 全部无阻塞项已过，当前 `受阻`（仅余 `herdr` AX 与本机 iOS 签名/配对）；W2b 已完成项 3 开发签名实测，当前 `受阻`（余项 1 AX 与项 2/4 停机窗口）。
- **执行方 B（`~/work/scry-B` / `exec/B`）**：W3 已通过；W2 代码已通过；W7 已提交初版报告，`W7-review.md` 待补测 4 项与维护者决定。
- **执行方 C（`~/work/scry-C` / `exec/C`）**：W4 已通过；W5 正在返修（另含 `W6-review.md` 转交的 `host-process.ts` 拆分与 `dispose` 修复）；本机仍可见约 23 对 `~/work/scry-C` 下的空闲 `daemon-supervisor.js` + `daemon.js`（CPU 0.0%，其中 PID `35590` 占着默认 LAN 端口 `47820`，执行方 A 未触碰）。
- **是否满足注销/重启条件**：**否**（B 的 W7 与 C 的 W5/W6 返修尚未全部收尾，且尚未与维护者约定停机时间）。

## 4. 失败与处理

1. **项 3 首次跑在 `~/Documents` 下触发内核级 TCC 阻塞（真实 OS 权限行为，非脚本误判）**：首次将 daemon 终端 `cwd` 与 Codex 工作区直接设为 `~/Documents/scry-w2b3-tcc-测试-*` 时，Codex `initialize` 超时且 `/bin/zsh -l` 的 `path_helper -s` 在 `__fts_open -> open$NOCANCEL` 无限期挂起等待用户点击 macOS TCC「文稿」授权弹窗（保存于 `W2b/w2b-03-tcc-path-helper.sample.txt`）。改用 `/tmp` 对照工作区完成钥匙串/登录态与本地网络测试，并在末尾用 12 s 有界探测复证 `~/Documents` TCC 阻塞，确认是真实 TCC 门禁行为（注意：开发签名 `adhoc` 无固定 TeamIdentifier，正式 Developer ID 签名包在首次批准后的持久授权行为可能不同）。
2. **项 3 出站本地网络 `EHOSTUNREACH` 做了宿主对照**：`launchd` daemon 子进程连 `224.0.0.251:5353` 与 `30.7.224.1:80` 均报 `EHOSTUNREACH`，随手用当前 Shell 跑同款对照同样报 `EHOSTUNREACH`，避免了将当前网络/宿主限制误判为 `Scry.app` 独有缺陷。

## 5. 与设计的出入

- 项 3 按维护者 2026-11-20 决定使用开发签名包（`Signature=adhoc`）实测，并在结论与验收表中显式标注「开发签名，正式包行为可能不同」。全程只用临时测试标签、临时服务目录、独立 `userData` 与临时 `~/Documents` 子目录（测试结束已删除），未触碰日常 `com.scry.daemon`、`~/Library/LaunchAgents` 与真实 `scry.db`。

## 6. 未验证

- 项 2（真实注销再登录）与项 4（FileVault 重启）：待 B、C 全部停工并与维护者约定停机窗口。
- 项 3 正式 Developer ID 签名包上的 TCC 持久授权、钥匙串 ACL 与跨设备（iPhone → Mac）真实 LAN 连通。
- 项 5（Linux 真机）：`not-run`。

## 7. 需要维护者决定

- 当前无新增待决设计项；待 B、C 全部停工且无 `MEASURING` 文件时，由执行方 A 提议项 2（真实注销再登录）与项 4（FileVault 重启）的停机窗口。
